// REVELA — laboratório de vídeo
// Recebe vídeos (upload retomável, sem limite fixo) ou links e devolve um link MP4 direto, tocável em qualquer navegador.
'use strict';
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

// ---------------- Configuração ----------------
const CFG = {
  porta: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dados: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  diasExpirar: Number(process.env.DIAS_EXPIRAR || 0),        // 0 = nunca apaga
  urlPublica: (process.env.URL_PUBLICA || '').replace(/\/$/, ''),
  maxLado: Number(process.env.MAX_LADO ?? 1920),            // maior lado ao recodificar (0 = mantém)
  crf: Number(process.env.CRF || 21),
  preset: process.env.PRESET || 'veryfast',
  conversoes: Math.max(1, Number(process.env.CONVERSOES_SIMULTANEAS || 1)),
  downloads: Math.max(1, Number(process.env.DOWNLOADS_SIMULTANEOS || 2)),
  reservaGB: Number(process.env.RESERVA_GB || 1),           // espaço que nunca é usado
  bin: {
    ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
    ffprobe: process.env.FFPROBE_BIN || 'ffprobe',
    ytdlp: process.env.YTDLP_BIN || 'yt-dlp',
  },
};
const CHUNK = 8 * 1024 * 1024; // 8 MB: passa por Cloudflare, nginx e proxies sem bater limite de corpo

const DIR = {
  up: path.join(CFG.dados, 'uploads'),
  work: path.join(CFG.dados, 'work'),
  out: path.join(CFG.dados, 'videos'),
  meta: path.join(CFG.dados, 'meta'),
  jobs: path.join(CFG.dados, 'jobs'),
};
Object.values(DIR).forEach(d => fs.mkdirSync(d, { recursive: true }));
const COOKIES = path.join(CFG.dados, 'cookies.txt');

const novoId = (n = 10) => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.randomBytes(n);
  return Array.from(b, x => abc[x % abc.length]).join('');
};
const limpo = s => String(s || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
const agora = () => Date.now();
const dorme = ms => new Promise(r => setTimeout(r, ms));

async function espacoLivre() {
  try { const s = await fsp.statfs(CFG.dados); return s.bavail * s.bsize; } catch { return Infinity; }
}
const GB = 1024 ** 3;
const fmtGB = b => (b / GB).toFixed(b < 10 * GB ? 1 : 0) + ' GB';

async function gravarJSON(arq, obj) {
  const tmp = arq + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, arq);
}
const lerJSON = async arq => JSON.parse(await fsp.readFile(arq, 'utf8'));

// ---------------- Ferramentas disponíveis (mostradas no site) ----------------
function versao(bin, args, re) {
  try { const o = execFileSync(bin, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }); const m = o.match(re); return m ? m[1] : o.trim().split('\n')[0]; }
  catch { return null; }
}
const FERR = {
  ffmpeg: versao(CFG.bin.ffmpeg, ['-version'], /ffmpeg version (\S+)/),
  ffprobe: versao(CFG.bin.ffprobe, ['-version'], /ffprobe version (\S+)/),
  ytdlp: versao(CFG.bin.ytdlp, ['--version'], /^(\S+)/),
  node: process.versions.node,
};
if (!FERR.ffmpeg || !FERR.ffprobe) console.error('!! FFmpeg/FFprobe não encontrados — a conversão não vai funcionar.');
if (!FERR.ytdlp) console.error('!! yt-dlp não encontrado — links não vão funcionar.');

// ---------------- App ----------------
const app = express();
// Express 4 não captura erros de funções async: embrulha todas as rotas
for (const metodo of ['get', 'post', 'put', 'delete']) {
  const orig = app[metodo].bind(app);
  app[metodo] = (rota, ...fns) => (metodo === 'get' && fns.length === 0) ? orig(rota)
    : orig(rota, ...fns.map(fn => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } }));
}
process.on('unhandledRejection', e => console.error('[erro não tratado]', e));
process.on('uncaughtException', e => console.error('[exceção]', e));
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

const base = req => CFG.urlPublica || `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;

app.get('/api/status', async (req, res) => {
  const livre = await espacoLivre();
  res.json({
    online: true,
    livreBytes: Number.isFinite(livre) ? Math.max(0, livre - CFG.reservaGB * GB) : null,
    ferramentas: FERR,
    cookies: fs.existsSync(COOKIES),
    fila: { convertendo: ativos.conv, baixando: ativos.down, esperando: filaConv.length + filaDown.length },
    diasExpirar: CFG.diasExpirar,
    chunk: CHUNK,
  });
});

// ---------------- Upload retomável em pedaços paralelos ----------------
// O arquivo é pré-alocado e cada pedaço é gravado na sua posição. O servidor lembra quais pedaços já chegaram,
// então o envio continua de onde parou mesmo depois de queda de internet, recarregar a página ou reiniciar o servidor.
const uploads = new Map();
const totalPedacos = m => Math.ceil(m.size / CHUNK);

async function carregarUpload(id) {
  id = limpo(id);
  if (uploads.has(id)) return uploads.get(id);
  try {
    const m = await lerJSON(path.join(DIR.up, id + '.json'));
    if (!fs.existsSync(m.file)) { await fsp.rm(path.join(DIR.up, id + '.json'), { force: true }); return null; }
    m.recebidos = new Set(m.recebidos);
    uploads.set(id, m);
    return m;
  } catch { return null; }
}
const salvarUploadAgendado = new Map();
function esquecerUpload(id) { clearTimeout(salvarUploadAgendado.get(id)); salvarUploadAgendado.delete(id); uploads.delete(id); }
function salvarUpload(m, ja = false) {
  const f = async () => { salvarUploadAgendado.delete(m.id); if (uploads.get(m.id) !== m) return; await gravarJSON(path.join(DIR.up, m.id + '.json'), { ...m, recebidos: [...m.recebidos] }).catch(() => {}); };
  if (ja) return f();
  if (!salvarUploadAgendado.has(m.id)) salvarUploadAgendado.set(m.id, setTimeout(f, 800));
}
const resumoUpload = m => ({ id: m.id, chunk: CHUNK, total: totalPedacos(m), recebidos: [...m.recebidos], size: m.size });

app.post('/api/upload', async (req, res) => {
  const { name, size, chave } = req.body || {};
  if (!name || !Number.isSafeInteger(size) || size <= 0) return res.status(400).json({ erro: 'Arquivo inválido.' });
  // mesmo arquivo de novo? continua o envio que já existe
  const ch = String(chave || '').slice(0, 300);
  if (ch) {
    for (const f of await fsp.readdir(DIR.up)) {
      if (!f.endsWith('.json')) continue;
      const m = await carregarUpload(f.slice(0, -5));
      if (m && m.chave === ch && m.size === size) return res.json(resumoUpload(m));
    }
  }
  // precisa caber o original + o MP4 final (no pior caso do mesmo tamanho) + reserva
  const livre = await espacoLivre();
  const precisa = size * 2 + CFG.reservaGB * GB;
  if (livre < precisa) {
    return res.status(507).json({ erro: `Sem espaço no servidor: esse vídeo precisa de ~${fmtGB(size * 2)} livres (original + MP4) e há ${fmtGB(Math.max(0, livre - CFG.reservaGB * GB))}.` });
  }
  const id = novoId(16);
  const m = { id, name: String(name).slice(0, 240), size, chave: ch, criado: agora(), recebidos: new Set(), file: path.join(DIR.up, id + '.bin') };
  const fd = await fsp.open(m.file, 'w');
  await fd.truncate(size); // arquivo esparso: não ocupa espaço até os dados chegarem
  await fd.close();
  uploads.set(id, m);
  await salvarUpload(m, true);
  res.json(resumoUpload(m));
});

app.get('/api/upload/:id', async (req, res) => {
  const m = await carregarUpload(req.params.id);
  if (!m) return res.status(404).json({ erro: 'Envio não encontrado (pode ter expirado).' });
  res.json(resumoUpload(m));
});

app.put('/api/upload/:id/:n', express.raw({ type: () => true, limit: CHUNK + 4096 }), async (req, res) => {
  const m = await carregarUpload(req.params.id);
  if (!m) return res.status(404).json({ erro: 'Envio não encontrado (pode ter expirado).' });
  const n = Number(req.params.n);
  const total = totalPedacos(m);
  if (!Number.isInteger(n) || n < 0 || n >= total) return res.status(400).json({ erro: 'Pedaço inválido.' });
  const esperado = n === total - 1 ? m.size - n * CHUNK : CHUNK;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length !== esperado) return res.status(400).json({ erro: `Pedaço ${n} chegou incompleto (${buf?.length || 0} de ${esperado} bytes).` });
  const sha = req.get('x-sha256');
  if (sha && crypto.createHash('sha256').update(buf).digest('hex') !== sha) return res.status(422).json({ erro: `Pedaço ${n} chegou corrompido.` });
  const fd = await fsp.open(m.file, 'r+');
  try { await fd.write(buf, 0, buf.length, n * CHUNK); } finally { await fd.close(); }
  m.recebidos.add(n);
  salvarUpload(m);
  res.json({ ok: true, recebidos: m.recebidos.size, total });
});

app.post('/api/upload/:id/fim', async (req, res) => {
  const m = await carregarUpload(req.params.id);
  if (!m) return res.status(404).json({ erro: 'Envio não encontrado.' });
  const total = totalPedacos(m);
  if (m.recebidos.size !== total) {
    const faltam = []; for (let i = 0; i < total && faltam.length < 50; i++) if (!m.recebidos.has(i)) faltam.push(i);
    return res.status(409).json({ erro: 'Ainda faltam pedaços.', faltam });
  }
  const st = await fsp.stat(m.file);
  if (st.size !== m.size) return res.status(500).json({ erro: 'Tamanho final não confere.' });
  const origem = path.join(DIR.work, m.id + '.origem');
  await fsp.rename(m.file, origem);
  esquecerUpload(m.id);
  await fsp.rm(path.join(DIR.up, m.id + '.json'), { force: true });
  const job = await criarJob({ tipo: 'upload', titulo: m.name, origem });
  res.json({ job: job.id, chaveApagar: job.chaveApagar });
});

app.delete('/api/upload/:id', async (req, res) => {
  const m = await carregarUpload(req.params.id);
  if (m) { esquecerUpload(m.id); await fsp.rm(m.file, { force: true }); await fsp.rm(path.join(DIR.up, m.id + '.json'), { force: true }); }
  res.json({ ok: true });
});

// ---------------- Links ----------------
app.post('/api/link', async (req, res) => {
  const url = String((req.body || {}).url || '').trim();
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return res.status(400).json({ erro: 'Isso não é um link válido (precisa começar com http:// ou https://).' }); }
  if (!FERR.ytdlp) return res.status(503).json({ erro: 'O yt-dlp não está instalado no servidor, então links não funcionam.' });
  if ((await espacoLivre()) < (CFG.reservaGB + 2) * GB) return res.status(507).json({ erro: 'O servidor está quase sem espaço. Apague vídeos antigos.' });
  const job = await criarJob({ tipo: 'link', titulo: url, url });
  res.json({ job: job.id, chaveApagar: job.chaveApagar });
});

// cookies.txt do YouTube (resolve "confirme que você não é um robô" e vídeos com restrição de idade)
app.put('/api/cookies', express.text({ type: () => true, limit: '2mb' }), async (req, res) => {
  const t = String(req.body || '');
  if (!/^# (Netscape )?HTTP Cookie File/m.test(t) && !/\t(TRUE|FALSE)\t/.test(t)) return res.status(400).json({ erro: 'Esse arquivo não parece um cookies.txt no formato Netscape.' });
  await fsp.writeFile(COOKIES, t, { mode: 0o600 });
  res.json({ ok: true });
});
app.delete('/api/cookies', async (req, res) => { await fsp.rm(COOKIES, { force: true }); res.json({ ok: true }); });

// ---------------- Trabalhos (persistentes em disco) ----------------
const jobs = new Map();
const filaDown = [], filaConv = [];
const ativos = { down: 0, conv: 0 };
const procs = new Map(); // job.id -> processo filho atual

const ESTADOS_FIM = ['pronto', 'erro', 'cancelado'];
const salvarJobAgendado = new Map();
function salvarJob(j, ja = false) {
  const f = () => { salvarJobAgendado.delete(j.id); return gravarJSON(path.join(DIR.jobs, j.id + '.json'), j).catch(() => {}); };
  if (ja) { clearTimeout(salvarJobAgendado.get(j.id)); return f(); }
  if (!salvarJobAgendado.has(j.id)) salvarJobAgendado.set(j.id, setTimeout(f, 1000));
}
function atualizar(j, campos, ja) { Object.assign(j, campos, { atualizado: agora() }); salvarJob(j, ja); }

async function criarJob(dados) {
  const j = { id: novoId(12), chaveApagar: novoId(20), estado: 'na fila', etapa: 'Na fila', progresso: 0, criado: agora(), ...dados };
  jobs.set(j.id, j);
  await salvarJob(j, true);
  enfileirar(j);
  return j;
}
function enfileirar(j) {
  if (j.tipo === 'link' && !j.baixado) filaDown.push(j); else filaConv.push(j);
  bombear();
}
function posicaoNaFila(j) {
  const i = filaDown.indexOf(j); if (i >= 0) return i + 1;
  const k = filaConv.indexOf(j); return k >= 0 ? k + 1 : 0;
}

function bombear() {
  while (ativos.down < CFG.downloads && filaDown.length) {
    const j = filaDown.shift(); if (j.estado === 'cancelado') continue;
    ativos.down++;
    baixar(j).then(arq => { atualizar(j, { origem: arq, baixado: true, estado: 'na fila', etapa: 'Baixado — aguardando conversão' }, true); filaConv.push(j); })
      .catch(e => falhar(j, e))
      .finally(() => { ativos.down--; bombear(); });
  }
  while (ativos.conv < CFG.conversoes && filaConv.length) {
    const j = filaConv.shift(); if (j.estado === 'cancelado') continue;
    ativos.conv++;
    converter(j).then(() => {})
      .catch(e => falhar(j, e))
      .finally(() => { ativos.conv--; bombear(); });
  }
}

async function falhar(j, e) {
  if (j.estado === 'cancelado') return;
  console.error('[falhou]', j.id, e && e.message);
  atualizar(j, { estado: 'erro', etapa: 'Falhou', erro: String(e && e.message || e).slice(0, 600) }, true);
  await limparTrabalho(j);
}
async function limparTrabalho(j) {
  if (j.origem) await fsp.rm(j.origem, { force: true }).catch(() => {});
  await fsp.rm(path.join(DIR.work, j.id), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(DIR.work, j.id + '.tmp.mp4'), { force: true }).catch(() => {});
}

const publicoJob = (j, req) => ({
  id: j.id, estado: j.estado, etapa: j.etapa, progresso: Math.round((j.progresso || 0) * 10) / 10, titulo: j.titulo,
  erro: j.erro, posicao: posicaoNaFila(j), detalhe: j.detalhe,
  video: j.video ? { ...j.video, url: `${base(req)}/v/${j.video.slug}.mp4` } : undefined,
});

app.get('/api/job/:id', (req, res) => {
  const j = jobs.get(limpo(req.params.id));
  if (!j) return res.status(404).json({ erro: 'Trabalho não encontrado.' });
  res.json(publicoJob(j, req));
});
app.post('/api/jobs', (req, res) => { // consulta vários de uma vez
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [];
  res.json(ids.map(id => { const j = jobs.get(limpo(id)); return j ? publicoJob(j, req) : { id, estado: 'sumiu' }; }));
});
app.delete('/api/job/:id', async (req, res) => {
  const j = jobs.get(limpo(req.params.id));
  if (!j) return res.status(404).json({ erro: 'Trabalho não encontrado.' });
  if (req.get('x-chave') !== j.chaveApagar) return res.status(403).json({ erro: 'Sem permissão.' });
  if (!ESTADOS_FIM.includes(j.estado)) {
    atualizar(j, { estado: 'cancelado', etapa: 'Cancelado' }, true);
    const p = procs.get(j.id); if (p) p.kill('SIGKILL');
    await limparTrabalho(j);
  }
  res.json({ ok: true });
});

// ---------------- Execução de processos ----------------
function exec(j, cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (j) procs.set(j.id, p);
    let out = '', err = '', resto = '';
    const linhas = s => { resto += s; const ps = resto.split(/\r\n|\r|\n/); resto = ps.pop(); if (onLine) ps.forEach(l => l && onLine(l)); };
    p.stdout.on('data', c => { const s = c.toString(); out += s; if (out.length > 4e6) out = out.slice(-2e6); linhas(s); });
    p.stderr.on('data', c => { const s = c.toString(); err = (err + s).slice(-20000); linhas(s); });
    p.on('error', e => reject(new Error(`Não consegui executar ${path.basename(cmd)}: ${e.message}`)));
    p.on('close', (code, sinal) => {
      if (j) procs.delete(j.id);
      if (resto && onLine) onLine(resto);
      if (j && j.estado === 'cancelado') return reject(new Error('Cancelado'));
      code === 0 ? resolve(out) : reject(Object.assign(new Error(`${path.basename(cmd)} falhou (${sinal || code})`), { stderr: err }));
    });
  });
}

// ---------------- Download de links (yt-dlp) ----------------
function traduzirErroYtdlp(txt) {
  const t = txt || '';
  const tab = [
    [/Sign in to confirm you.?re not a bot|confirm you are not a bot/i, 'O YouTube bloqueou este servidor e pediu login ("confirme que não é um robô"). Envie um cookies.txt em Ajustes que funciona.'],
    [/Sign in to confirm your age|age.?restricted|inappropriate for some users/i, 'Vídeo com restrição de idade. Envie um cookies.txt de uma conta logada em Ajustes.'],
    [/Private video|This video is private/i, 'Esse vídeo é privado.'],
    [/members-only|Join this channel/i, 'Vídeo só para membros do canal.'],
    [/Video unavailable|This video has been removed|not available in your country|geo.?restrict/i, 'Vídeo indisponível (removido ou bloqueado na região do servidor).'],
    [/is live|live event|Premieres in|is_live/i, 'Transmissões ao vivo e estreias que ainda não aconteceram não podem ser baixadas. Tente depois que a live acabar.'],
    [/Unsupported URL/i, 'Esse site não é suportado ou o link não aponta para um vídeo.'],
    [/Requested format is not available/i, 'O site não ofereceu nenhum formato de vídeo baixável.'],
    [/HTTP Error 404|404: Not Found/i, 'O link retornou "não encontrado" (404).'],
    [/HTTP Error 403|403: Forbidden/i, 'O site recusou o acesso (403). O link pode ter expirado ou exigir login.'],
    [/HTTP Error 429|Too Many Requests/i, 'O site limitou as requisições deste servidor (429). Espere alguns minutos e tente de novo.'],
    [/login required|log in|logged-in|cookies/i, 'Esse vídeo exige login. Envie um cookies.txt da sua conta em Ajustes.'],
    [/Unable to download webpage|Failed to resolve|getaddrinfo|timed out|Connection refused|Network is unreachable/i, 'Não consegui acessar o site (rede/servidor fora do ar).'],
    [/No space left/i, 'O servidor ficou sem espaço em disco.'],
  ];
  for (const [re, msg] of tab) if (re.test(t)) return msg;
  const l = t.split('\n').map(x => x.trim()).filter(x => /^ERROR:/i.test(x)).pop();
  return l ? l.replace(/^ERROR:\s*/, '').replace(/;? ?please report this issue.*$/i, '').slice(0, 300) : 'Não consegui baixar esse link.';
}

async function baixar(j) {
  atualizar(j, { estado: 'baixando', etapa: 'Baixando do link', progresso: 0, detalhe: '' });
  const dir = path.join(DIR.work, j.id);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const args = [
    '--no-playlist', '--no-warnings', '--newline', '--no-mtime', '--no-part', '--ignore-config',
    '--js-runtimes', `node:${process.execPath}`,             // usa o próprio Node para os desafios JS do YouTube
    '--retries', '10', '--fragment-retries', '10', '--concurrent-fragments', '4',
    // prefere H.264+AAC até 1080p (vira MP4 sem recodificar); senão o melhor até 1080p; senão qualquer um
    '-f', 'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][vcodec^=avc1][acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(dir, 'origem.%(ext)s'),
    '--print', 'before_dl:REVELA_TITULO %(title)s',
    '--print', 'before_dl:REVELA_LIVE %(is_live)s',
    '--progress-template', 'download:REVELA_PROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.format_id)s',
  ];
  if (fs.existsSync(COOKIES)) args.push('--cookies', COOKIES);
  args.push('--', j.url);
  let viu = new Set(), ultimo = 0;
  try {
    await exec(j, CFG.bin.ytdlp, args, l => {
      if (l.startsWith('REVELA_TITULO ')) { const t = l.slice(14).trim(); if (t && t !== 'NA') atualizar(j, { titulo: t }); }
      else if (l.startsWith('REVELA_LIVE True')) { const p = procs.get(j.id); if (p) p.kill(); j._live = true; }
      else if (l.startsWith('REVELA_PROG ')) {
        const [pct, vel, eta, fmt] = l.slice(12).split('|').map(s => s.trim());
        viu.add(fmt);
        const n = parseFloat(pct); if (!Number.isFinite(n)) return;
        // vídeo e áudio separados: cada um é metade da barra de download
        const peso = viu.size > 1 ? 50 : 100; const b = viu.size > 1 ? 50 : 0;
        const p = Math.min(100, b + n * peso / 100);
        if (Math.abs(p - ultimo) >= 0.5) { ultimo = p; atualizar(j, { progresso: p * 0.5, detalhe: `${vel} · falta ${eta}`.replace(/NA|Unknown/gi, '—') }); }
      }
    });
  } catch (e) {
    if (j._live) throw new Error('Transmissões ao vivo não podem ser baixadas enquanto estão no ar.');
    if (e.message === 'Cancelado') throw e;
    throw new Error(traduzirErroYtdlp(e.stderr || e.message));
  }
  const arqs = (await fsp.readdir(dir)).filter(f => f.startsWith('origem.') && !/\.(part|ytdl|tmp)$/.test(f)).map(f => path.join(dir, f));
  if (!arqs.length) throw new Error('O link não entregou nenhum vídeo.');
  const tams = await Promise.all(arqs.map(async f => [(await fsp.stat(f)).size, f]));
  return tams.sort((a, b) => b[0] - a[0])[0][1];
}

// ---------------- Conversão (FFmpeg) ----------------
async function sondar(arq) {
  let j;
  try { j = JSON.parse(await exec(null, CFG.bin.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', arq])); }
  catch (e) { throw new Error('Esse arquivo não é um vídeo que o FFmpeg consiga ler (pode estar corrompido ou incompleto).'); }
  const streams = j.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && !(s.disposition || {}).attached_pic);
  const a = streams.find(s => s.codec_type === 'audio');
  if (!v) throw new Error(a ? 'Esse arquivo só tem áudio, não tem imagem.' : 'Esse arquivo não tem trilha de vídeo.');
  let dur = Number(j.format?.duration || v.duration || 0);
  if (!Number.isFinite(dur)) dur = 0;
  const rot = Math.abs(Number(((v.side_data_list || []).find(d => d.rotation !== undefined) || {}).rotation || v.tags?.rotate || 0)) % 180;
  const [larg, alt] = rot === 90 ? [v.height, v.width] : [v.width, v.height];
  return { v, a, dur, larg, alt, formato: j.format?.format_name || '' };
}

function planoConversao(info, forcarTudo) {
  const { v, a } = info;
  const vOk = !forcarTudo && v.codec_name === 'h264' && /^(yuv420p|yuvj420p)$/.test(v.pix_fmt || '') && (v.width || 0) <= 4096;
  const aOk = !forcarTudo && (!a || ['aac', 'mp3'].includes(a.codec_name)) && (!a || (a.channels || 2) <= 2 || a.codec_name === 'aac');
  return { vCopia: vOk, aCopia: aOk };
}

function argsFFmpeg(origem, destino, info, plano) {
  const args = ['-hide_banner', '-nostdin', '-y', '-fflags', '+genpts', '-i', origem,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-max_muxing_queue_size', '9999'];
  if (plano.vCopia) args.push('-c:v', 'copy');
  else {
    const M = CFG.maxLado;
    const vf = [];
    if (M > 0) vf.push(`scale=w='if(gte(iw,ih),min(iw,${M}),-2)':h='if(gte(iw,ih),-2,min(ih,${M}))':flags=lanczos`);
    else vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    vf.push('format=yuv420p');
    args.push('-vf', vf.join(','), '-c:v', 'libx264', '-preset', CFG.preset, '-crf', String(CFG.crf), '-profile:v', 'high', '-level:v', '4.2');
    // limita fps absurdos (ex.: 240 fps de câmera lenta) para manter compatível
    const [fn, fd] = String(info.v.avg_frame_rate || '0/1').split('/').map(Number);
    if (fd && fn / fd > 60.5) args.push('-r', '60');
  }
  if (info.a) {
    if (plano.aCopia) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', destino);
  return args;
}

async function verificarSaida(arq, info) {
  const o = await sondar(arq);
  if (o.v.codec_name !== 'h264') throw new Error('Saída sem H.264');
  if (info.dur > 5 && o.dur > 0 && o.dur < info.dur * 0.9 - 2) throw Object.assign(new Error(`Saída ficou curta (${o.dur.toFixed(1)}s de ${info.dur.toFixed(1)}s)`), { curta: o });
  // moov antes de mdat (faststart): toca na hora sem baixar tudo
  const fd = await fsp.open(arq, 'r'); const b = Buffer.alloc(1 << 20); await fd.read(b, 0, b.length, 0); await fd.close();
  const iMoov = b.indexOf('moov'), iMdat = b.indexOf('mdat');
  if (iMoov < 0 || (iMdat >= 0 && iMoov > iMdat)) throw new Error('Saída sem faststart');
  return o;
}

async function converter(j) {
  const ini = j.tipo === 'link' ? 50 : 0, peso = 100 - ini;
  atualizar(j, { estado: 'convertendo', etapa: 'Analisando o vídeo', progresso: ini, detalhe: '' });
  if (!j.origem || !fs.existsSync(j.origem)) throw new Error('O arquivo original sumiu do servidor. Envie de novo.');
  const info = await sondar(j.origem);
  const tamOrig = (await fsp.stat(j.origem)).size;
  if ((await espacoLivre()) < tamOrig * 1.2 + CFG.reservaGB * GB) throw new Error('Sem espaço em disco para converter este vídeo.');
  const slug = j.slugReservado || novoId(10);
  atualizar(j, { slugReservado: slug });
  const tmp = path.join(DIR.work, j.id + '.tmp.mp4');
  const destino = path.join(DIR.out, slug + '.mp4');

  const tentar = async (plano) => {
    const rapida = plano.vCopia && plano.aCopia;
    atualizar(j, { etapa: rapida ? 'Ajustando para tocar direto (sem perder qualidade)' : plano.vCopia ? 'Convertendo só o áudio (imagem original preservada)' : 'Convertendo para MP4 universal (H.264 + AAC)' });
    const t0 = agora();
    await exec(j, CFG.bin.ffmpeg, argsFFmpeg(j.origem, tmp, info, plano), l => {
      const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && info.dur > 0) {
        const feito = Math.min(1, Number(m[1]) / 1e6 / info.dur);
        const seg = (agora() - t0) / 1000;
        const eta = feito > 0.02 ? seg / feito - seg : 0;
        atualizar(j, { progresso: ini + feito * 99 * peso / 100, detalhe: eta ? `falta ~${fmtDur(eta)}` : '' });
      }
    });
    return verificarSaida(tmp, info);
  };

  let plano = planoConversao(info, false), saida, aviso;
  try { saida = await tentar(plano); }
  catch (e) {
    if (e.message === 'Cancelado') throw e;
    if (plano.vCopia || plano.aCopia) { // a cópia direta falhou (timestamps quebrados etc.): recodifica tudo
      console.warn('[conversão] cópia falhou, recodificando:', e.message, (e.stderr || '').slice(-300));
      plano = planoConversao(info, true);
      try { saida = await tentar(plano); }
      catch (e2) {
        if (e2.message === 'Cancelado') throw e2;
        if (e2.curta && e2.curta.dur >= 1) { saida = e2.curta; aviso = `O arquivo original estava incompleto: deu para recuperar ${fmtDur(saida.dur)} de ${fmtDur(info.dur)}.`; }
        else throw new Error(erroFFmpeg(e2));
      }
    } else if (e.curta && e.curta.dur >= 1) { saida = e.curta; aviso = `O arquivo original estava incompleto: deu para recuperar ${fmtDur(saida.dur)} de ${fmtDur(info.dur)}.`; }
    else throw new Error(erroFFmpeg(e));
  }
  await fsp.rename(tmp, destino);
  const st = await fsp.stat(destino);
  const video = {
    slug, titulo: j.titulo, bytes: st.size, duracao: saida.dur || info.dur, largura: saida.larg, altura: saida.alt, aviso,
    recodificado: !plano.vCopia, criado: agora(), chaveApagar: j.chaveApagar,
  };
  await gravarJSON(path.join(DIR.meta, slug + '.json'), video);
  await fsp.rm(j.origem, { force: true }).catch(() => {});
  await fsp.rm(path.join(DIR.work, j.id), { recursive: true, force: true }).catch(() => {});
  const { chaveApagar, ...pub } = video;
  atualizar(j, { estado: 'pronto', etapa: 'Pronto', progresso: 100, detalhe: '', video: pub, origem: null }, true);
}
function erroFFmpeg(e) {
  if (e.curta) return `O arquivo está incompleto: só ${e.curta.dur.toFixed(1)}s puderam ser lidos. Envie o arquivo inteiro de novo.`;
  const s = e.stderr || '';
  if (/No space left/i.test(s)) return 'O servidor ficou sem espaço em disco durante a conversão.';
  if (/Invalid data found|moov atom not found|could not find codec/i.test(s)) return 'O arquivo está corrompido ou incompleto e não deu para converter.';
  return 'A conversão falhou: ' + (s.trim().split('\n').filter(l => /error|invalid|failed/i.test(l)).pop() || e.message).slice(0, 250);
}
const fmtDur = s => { s = Math.round(s); const h = s / 3600 | 0, m = (s % 3600) / 60 | 0, x = s % 60; return h ? `${h}h${String(m).padStart(2, '0')}` : m ? `${m}min ${x}s` : `${x}s`; };

// ---------------- Entrega do MP4 ----------------
const cabecalhosVideo = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
};
app.get(['/v/:slug.mp4', '/v/:slug'], (req, res) => {
  const slug = limpo(req.params.slug);
  const arq = path.join(DIR.out, slug + '.mp4');
  if (!fs.existsSync(arq)) return res.status(404).type('text/plain; charset=utf-8').send('Vídeo não encontrado (pode ter sido apagado ou expirado).');
  res.set(cabecalhosVideo);
  if ('baixar' in req.query) {
    let nome = slug;
    try { nome = (JSON.parse(fs.readFileSync(path.join(DIR.meta, slug + '.json'), 'utf8')).titulo || slug).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\.[a-z0-9]{2,4}$/i, '').trim().slice(0, 120) || slug; } catch {}
    res.attachment(nome + '.mp4');
  }
  res.sendFile(arq, { headers: { 'Content-Type': 'video/mp4' }, acceptRanges: true, cacheControl: false, lastModified: true });
});

app.get('/api/video/:slug', async (req, res) => {
  try {
    const { chaveApagar, ...v } = await lerJSON(path.join(DIR.meta, limpo(req.params.slug) + '.json'));
    if (!fs.existsSync(path.join(DIR.out, v.slug + '.mp4'))) throw 0;
    res.json({ ...v, url: `${base(req)}/v/${v.slug}.mp4` });
  } catch { res.status(404).json({ erro: 'Vídeo não encontrado.' }); }
});

app.delete('/api/video/:slug', async (req, res) => {
  const s = limpo(req.params.slug);
  try {
    const v = await lerJSON(path.join(DIR.meta, s + '.json'));
    if (req.get('x-chave') !== v.chaveApagar) return res.status(403).json({ erro: 'Só o aparelho que criou esse link pode apagar.' });
  } catch { return res.json({ ok: true }); }
  await fsp.rm(path.join(DIR.out, s + '.mp4'), { force: true });
  await fsp.rm(path.join(DIR.meta, s + '.json'), { force: true });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h', setHeaders(res, p) { if (/(index\.html|sw\.js)$/.test(p)) res.set('Cache-Control', 'no-cache'); } }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Pedaço grande demais.' });
  if (err.type === 'request.aborted') return;
  console.error(err);
  res.status(500).json({ erro: 'Erro interno: ' + err.message });
});

// ---------------- Recuperação após reinício ----------------
async function recuperar() {
  for (const f of await fsp.readdir(DIR.work)) if (f.endsWith('.tmp.mp4')) await fsp.rm(path.join(DIR.work, f), { force: true });
  const lista = [];
  for (const f of await fsp.readdir(DIR.jobs)) {
    if (!f.endsWith('.json')) continue;
    try { lista.push(await lerJSON(path.join(DIR.jobs, f))); } catch { await fsp.rm(path.join(DIR.jobs, f), { force: true }); }
  }
  lista.sort((a, b) => a.criado - b.criado);
  let retomados = 0;
  for (const j of lista) {
    jobs.set(j.id, j);
    if (ESTADOS_FIM.includes(j.estado)) continue;
    if (j.estado === 'baixando' || (j.tipo === 'link' && !j.baixado)) { j.baixado = false; }
    else if (!j.origem || !fs.existsSync(j.origem)) { j.estado = 'erro'; j.erro = 'O servidor reiniciou e o arquivo original se perdeu. Envie de novo.'; salvarJob(j, true); continue; }
    atualizar(j, { estado: 'na fila', etapa: 'Retomando após reinício do servidor', progresso: j.tipo === 'link' && j.baixado ? 50 : 0 }, true);
    enfileirar(j); retomados++;
  }
  if (retomados) console.log(`Retomando ${retomados} trabalho(s) interrompido(s).`);
}

// ---------------- Faxina ----------------
async function faxina() {
  const t = agora();
  for (const f of await fsp.readdir(DIR.up)) { // envios abandonados há mais de 3 dias
    if (!f.endsWith('.json')) continue;
    const p = path.join(DIR.up, f), st = await fsp.stat(p).catch(() => null);
    if (st && t - st.mtimeMs > 3 * 864e5) { const id = f.slice(0, -5); esquecerUpload(id); await fsp.rm(p, { force: true }); await fsp.rm(path.join(DIR.up, id + '.bin'), { force: true }); }
  }
  for (const [id, j] of jobs) { // registros de trabalhos terminados há mais de 7 dias
    if (ESTADOS_FIM.includes(j.estado) && t - (j.atualizado || j.criado) > 7 * 864e5) { jobs.delete(id); await fsp.rm(path.join(DIR.jobs, id + '.json'), { force: true }); }
  }
  if (CFG.diasExpirar > 0) {
    for (const f of await fsp.readdir(DIR.meta)) {
      const p = path.join(DIR.meta, f), st = await fsp.stat(p).catch(() => null);
      if (st && t - st.mtimeMs > CFG.diasExpirar * 864e5) { await fsp.rm(p, { force: true }); await fsp.rm(path.join(DIR.out, f.replace(/\.json$/, '.mp4')), { force: true }); }
    }
  }
}

// ---------------- Início ----------------
function ipsLocais() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}
async function iniciar() {
  await recuperar();
  setInterval(() => faxina().catch(console.error), 3600e3);
  faxina().catch(console.error);
  const srv = app.listen(CFG.porta, CFG.host, () => {
    console.log(`\n  REVELA no ar  →  http://localhost:${CFG.porta}`);
    ipsLocais().forEach(ip => console.log(`  Na mesma Wi-Fi →  http://${ip}:${CFG.porta}`));
    console.log(`  Dados em ${CFG.dados}`);
    console.log(`  FFmpeg ${FERR.ffmpeg || 'AUSENTE'} · yt-dlp ${FERR.ytdlp || 'AUSENTE'} · Node ${FERR.node}\n`);
  });
  srv.requestTimeout = 0;           // envios lentos não são cortados
  srv.headersTimeout = 120000;
  srv.keepAliveTimeout = 65000;
  const sair = () => { for (const p of procs.values()) try { p.kill('SIGKILL'); } catch {} process.exit(0); };
  process.on('SIGINT', sair); process.on('SIGTERM', sair);
}
iniciar().catch(e => { console.error(e); process.exit(1); });
