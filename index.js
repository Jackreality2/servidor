const play = require('play-dl');
play.getFreeClientID().then((clientID) => {
    play.setToken({ soundcloud: { client_id: clientID } });
});
// --- TRATAMENTO GLOBAL DE EXCEÇÕES (EVITA CRASH DO NODE.JS) ---
process.on('uncaughtException', (err) => {
    console.error('⚠️ [ESCUDO GLOBAL] Erro não capturado (evitou o crash):', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [ESCUDO GLOBAL] Promessa rejeitada (evitou o crash):', reason);
});

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const cron = require('node-cron');
const http = require('http');
const axios = require('axios');
const { randomUUID } = require('crypto');
const fs = require('fs');
const { PassThrough } = require('stream');
const googleTTS = require('google-tts-api');
const { criarSessaoTriagem, adicionarMidiaTriagem, montarResumoTriagem } = require('./triagem');
const { criarAnaliseDiaria, dataHojeSaoPaulo, formatarDocumentoDiario } = require('./documento');

const ffmpegPath = require('ffmpeg-static');
const fluentFfmpeg = require('fluent-ffmpeg');
fluentFfmpeg.setFfmpegPath(ffmpegPath);

const logger = P({ level: 'silent' });

// --- CONFIGURAÇÕES MASTER ---
const DONO_SUPREMO = '5521983161582@s.whatsapp.net';
const DONO_ADMIN   = '5521935052708@s.whatsapp.net';
const ID_DO_GRUPO  = '120363425471646460@g.us';
const PRECO_ALUGUEL_MENSAL = 10;
const DURACAO_ALUGUEL_MS = 30 * 24 * 60 * 60 * 1000;

// --- ESTADO GERAL ---
let blacklist = {};
let inativoAtivo = {};
let ultimaMsgGrupo = {};
let agendamentos = [];
let pontosSorteio = {};
let sorteiosAtivosPorGrupo = {};
let sorteiosContagemPorGrupo = {};
let textosAberturaPorGrupo = {};
let textosFechamentoPorGrupo = {};
let grupoLocalOcorrencias = null;
let gruposOcorrenciaAtivos = {};
let filaSyncGithub = Promise.resolve();
const mutesTemporarios = {};
const PONTOS_POR_MUTAR = 1;
const MIN_PONTOS_RANKING = 2;
let sorteioEmExecucao = false;
let perfis = {};
let perfilEmRegistro = {};
let interacaoPerfil = {};
let mutados = [];
let jogoCidade = { ativo: false, emAndamento: false, jogadores: [], assassino: null, xerife: null, aguardando: null, grupo: null };
let apenasAdmAtivo = {};
let advertencias = {};
let historicoComandos = [];
let botSilenciado = false;
let cooldowns = {};
let qrAtual = null;
let estatisticas = {};
let contagemAtiva = {};
let saldosUFSC = {};
let anagramaGame = { ativo: false, palavra: '', embaralhada: '', jid: '' };
let notificacoesAtivas = {};
let solicitacoesPendentes = {};
let precoFigurinha = 2;
let ultimaInteracao = {};
let gruposRegistrados = [];
let alugueisPendentes = {};
let alugueisAtivosPorGrupo = {};
let verificacaoAluguelEmAndamento = false;
const fluxosAluguel = {};
let senhaRegistro = null;
let grupoTriagemAtivo = null;
const gruposTriagemPorCodigo = {};
const triagensAtivasPorCodigo = {};
const estadosTriagem = {};
let imagemComer = null;
const caminhoImagemSono = './imagem_sono.jpg';
let imagemSono = fs.existsSync(caminhoImagemSono) ? fs.readFileSync(caminhoImagemSono) : null;
const caminhoLogoBot = './logo_bot.jpg';
let logoBot = fs.existsSync(caminhoLogoBot) ? fs.readFileSync(caminhoLogoBot) : null;
const ultimaRespostaIA = {};
const historicoIA = {};
const datasEntradaGrupo = {};
const votacoesEliminacao = {};
const sorteiosGrupo = {};
const caminhoAnunciosLinks = './anuncios_links.json';
let anunciosLinks = [];
try {
    anunciosLinks = JSON.parse(fs.readFileSync(caminhoAnunciosLinks, 'utf8'));
    if (!Array.isArray(anunciosLinks)) anunciosLinks = [];
} catch {
    anunciosLinks = [];
}
const sessoesTriagem = {};
const triagensFinalizadas = new Set();
const analise = {
  registrarMensagem() {},
  registrarComando() {},
  obterMensagens() { return []; },
  obterRelatorio() { return this.obterDia(); },
  obterDia(data) {
    const fs = require('fs');
    const path = require('path');
    const caminho = path.resolve(__dirname, 'documento_estatisticas.json');

    if (!fs.existsSync(caminho)) {
      return { total: 0, enviadas: 0, recebidas: 0, porConversa: {}, porTipo: {} };
    }

    try {
      const dados = JSON.parse(fs.readFileSync(caminho, 'utf-8'));
      const chaveData = data || new Date().toISOString().split('T')[0];
      
      return dados[chaveData] || dados[Object.keys(dados).pop()] || {};
    } catch (e) {
      return { total: 0, enviadas: 0, recebidas: 0, porConversa: {}, porTipo: {} };
    }
  }
};

const analiseDiaria = analise;
const documentosPendentes = {};

function identificarTipoMidia(conteudo) {
    let mensagem = conteudo || {};
    for (let nivel = 0; nivel < 4; nivel++) {
        const wrapper = mensagem.ephemeralMessage || mensagem.viewOnceMessage
            || mensagem.viewOnceMessageV2 || mensagem.documentWithCaptionMessage;
        if (!wrapper?.message) break;
        mensagem = wrapper.message;
    }
    const tipos = {
        imageMessage: 'foto',
        image: 'foto',
        audioMessage: 'áudio',
        audio: 'áudio',
        videoMessage: 'vídeo',
        video: 'vídeo',
        documentMessage: 'documento',
        document: 'documento',
        stickerMessage: 'figurinha',
        sticker: 'figurinha',
        contactMessage: 'contato',
        contactsArrayMessage: 'contatos',
        locationMessage: 'localização',
        liveLocationMessage: 'localização ao vivo',
        reactionMessage: 'reação',
        react: 'reação',
        pollCreationMessage: 'enquete',
        pollCreationMessageV3: 'enquete',
        pollUpdateMessage: 'voto em enquete',
        buttonsMessage: 'botões',
        listMessage: 'lista'
    };
    const tipo = Object.keys(tipos).find((chave) => mensagem[chave]);
    return tipo ? tipos[tipo] : null;
}

function extrairTextoRecebido(conteudo) {
    let mensagem = conteudo || {};
    for (let nivel = 0; nivel < 4; nivel++) {
        const wrapper = mensagem.ephemeralMessage || mensagem.viewOnceMessage
            || mensagem.viewOnceMessageV2 || mensagem.documentWithCaptionMessage;
        if (!wrapper?.message) break;
        mensagem = wrapper.message;
    }
    return mensagem.conversation || mensagem.extendedTextMessage?.text
        || mensagem.imageMessage?.caption || mensagem.videoMessage?.caption
        || mensagem.documentMessage?.caption || mensagem.buttonsResponseMessage?.selectedButtonId
        || mensagem.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}

function extrairTextoEnviado(conteudo) {
    return conteudo?.text || conteudo?.caption || conteudo?.buttonsMessage?.contentText
        || conteudo?.listMessage?.description || conteudo?.templateMessage?.hydratedTemplate?.hydratedContentText || '';
}

// SISTEMA UNO
// ============================================================
let unoGame = {
    ativo: false, emAndamento: false, jogadores: [],
    baralho: [], descarte: [], jogadorVez: 0, corAtual: null,
    sentido: 1, grupo: null, cartasPorHash: {}, aguardandoCor: null, pularAposCor: false
};
const UNO_CORES = ['red', 'yellow', 'green', 'blue'];
const UNO_CORES_PT = { red: 'vermelho', yellow: 'amarelo', green: 'verde', blue: 'azul', wild: 'coringa' };
const UNO_COR_HEX = { red: 'e53935', yellow: 'fdd835', green: '43a047', blue: '1e88e5', wild: '212121' };
const UNO_COR_EMOJI = { red: '🔴', yellow: '🟡', green: '🟢', blue: '🔵', wild: '🎨' };

// ============================================================
// NOVO: STATUS REAL DA CONEXÃO (para a página não mentir)
// 'conectado' | 'desconectado' | 'aguardando_qr'
// ============================================================
let statusConexao = 'desconectado';
let ultimoPingRecebido = Date.now();

// ============================================================
// NOVO: SISTEMA ANTI-FLOOD
// ============================================================
let floodAtivo = {};
let floodContagem = {};
const FLOOD_LIMITE = 5;
const FLOOD_JANELA = 5 * 60 * 1000;

// ============================================================
// NOVO: RASTREAMENTO DE MENSAGENS PARA .apagar
// ============================================================
const mensagensRastreadas = {};
const LIMITE_RASTRO = 500;

// ============================================================
// NOVO: .pickall
// ============================================================
let pickallPendente = {};
const SENHA_PICKALL = '1717';

// ============================================================
// SISTEMA DE FILA SEQUENCIAL
// ============================================================
let filaAtiva         = false;
let linkGrupoTriagem  = null;
let contadorTicket    = 0;
const filaPendente    = [];
let   filaEmAnalise   = null;

// ============================================================
// SISTEMA DE ADMINS DE TRIAGEM
// ============================================================
const adminsTriagem          = {};
let   sessaoTriagemResponsavel = null;
let   metaTriagens           = 10;

function obterEstadoTriagem(grupoJid) {
    if (!grupoJid) return null;
    if (!estadosTriagem[grupoJid]) {
        estadosTriagem[grupoJid] = {
            grupoJid,
            ativa: false,
            filaAtiva: false,
            linkGrupo: null,
            contadorTicket: 0,
            filaPendente: [],
            filaEmAnalise: null,
            finalizadas: new Set(),
            responsavel: null,
            metaTriagens: 10
        };
    }
    return estadosTriagem[grupoJid];
}

// ============================================================
// SISTEMA DE ALERTA TIKTOK
// ============================================================
const alertasTikTok = {};

// --- hash simples para senha ---
function hashSenha(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
    return h.toString(16);
}

async function buscarUltimoVideoTikTok(username) {
    const url = `https://www.tiktok.com/@${username}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Referer': 'https://www.tiktok.com/',
    };
    const res = await axios.get(url, { headers, timeout: 15000 });
    const sigiMatch = res.data.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (!sigiMatch) throw new Error('SIGI_STATE não encontrado');
    const sigi = JSON.parse(sigiMatch[1]);
    const itemModule = sigi?.ItemModule || sigi?.itemModule;
    if (!itemModule) throw new Error('ItemModule não encontrado');
    const videos = Object.values(itemModule);
    if (!videos.length) throw new Error('Nenhum vídeo');
    videos.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
    const latest = videos[0];
    return { id: latest.id, titulo: latest.desc || 'Sem título', link: `https://www.tiktok.com/@${username}/video/${latest.id}` };
}

async function baixarImagemMeme(url) {
    let urlMeme;
    try {
        urlMeme = new URL(url);
    } catch {
        return null;
    }

    const hostsPermitidos = ['i.redd.it', 'preview.redd.it', 'external-preview.redd.it', 'i.imgur.com'];
    const hostPermitido = hostsPermitidos.some((host) =>
        urlMeme.hostname === host || urlMeme.hostname.endsWith(`.${host}`)
    );
    if (urlMeme.protocol !== 'https:' || !hostPermitido || !/\.(jpe?g|png|webp)$/i.test(urlMeme.pathname)) {
        return null;
    }

    try {
        const imagem = await axios.get(urlMeme.href, {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxContentLength: 8 * 1024 * 1024,
            maxRedirects: 0
        });
        const tipoImagem = imagem.headers['content-type']?.split(';')[0].toLowerCase();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(tipoImagem)) return null;
        return Buffer.from(imagem.data);
    } catch (errImagem) {
        console.error('[meme] falha ao baixar imagem:', errImagem.message);
        return null;
    }
}

function escolherSubredditsMeme(termo) {
    return ['memesbrasil', 'memesbr'];
}

async function buscarMemeAlternativo(termo) {
    const subreddits = escolherSubredditsMeme(termo);
    const respostas = await Promise.all(subreddits.map(async (subreddit) => {
        try {
            const resposta = await axios.get(`https://meme-api.com/gimme/${encodeURIComponent(subreddit)}/20`, { timeout: 12000 });
            return resposta.data?.memes || (resposta.data?.url ? [resposta.data] : []);
        } catch (err) {
            console.error(`[meme] fonte alternativa r/${subreddit} falhou:`, err.message);
            return [];
        }
    }));
    const termoNormalizado = termo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const palavrasBusca = termoNormalizado.split(/\s+/).filter((palavra) => palavra.length > 2);
    const memes = respostas.flat().filter((meme) =>
        meme && meme.nsfw !== true && meme.spoiler !== true && typeof meme.url === 'string'
    );
    const relacionados = memes.filter((meme) => {
        const titulo = (meme.title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        return palavrasBusca.some((palavra) => titulo.includes(palavra));
    });
    const candidatos = relacionados.length ? relacionados : memes;

    for (const meme of candidatos.sort(() => Math.random() - 0.5)) {
        const buffer = await baixarImagemMeme(meme.url);
        if (!buffer) continue;
        return {
            buffer,
            titulo: typeof meme.title === 'string' ? meme.title : `Meme sobre ${termo}`,
            subreddit: typeof meme.subreddit === 'string' ? meme.subreddit : null
        };
    }
    throw new Error(`A fonte alternativa não retornou imagens compatíveis para: ${termo}`);
}

async function buscarMemeSeguro(termo = '') {
    return buscarMemeAlternativo(termo);
}

async function responderComIA(sock, jid, texto, sender) {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!texto || texto.startsWith('.')) return;
    if (!apiKey) {
        await sock.sendMessage(jid, { text: '⚠️ A IA ainda não está configurada. O administrador precisa definir OPENROUTER_API_KEY no ambiente do bot.' });
        return;
    }

    const agora = Date.now();
    if (ultimaRespostaIA[jid] && agora - ultimaRespostaIA[jid] < 20000) return;
    ultimaRespostaIA[jid] = agora;

    if (!historicoIA[jid]) historicoIA[jid] = [];
    historicoIA[jid].push({ role: 'user', content: `${sender.split('@')[0]}: ${texto.slice(0, 3000)}` });
    historicoIA[jid] = historicoIA[jid].slice(-8);

    try {
        const modelo = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
        const resposta = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: modelo,
            messages: [
                {
                    role: 'system',
                    content: 'Você é o assistente amigável de um grupo de WhatsApp. Responda em português do Brasil, com naturalidade e brevidade. Não invente informações, não seja ofensivo e não mencione que é uma IA. Responda em no máximo 3 frases.'
                },
                ...historicoIA[jid]
            ],
            temperature: 0.8,
            max_tokens: 220
        }, {
            timeout: 30000,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/',
                'X-Title': 'Atrino WhatsApp Bot'
            }
        });
        const textoResposta = resposta.data?.choices?.[0]?.message?.content?.trim();
        if (!textoResposta) throw new Error('OpenRouter retornou uma resposta vazia.');
        historicoIA[jid].push({ role: 'assistant', content: textoResposta });
        historicoIA[jid] = historicoIA[jid].slice(-8);
        await sock.sendMessage(jid, { text: `🤖 ${textoResposta}` });
    } catch (errIA) {
        delete ultimaRespostaIA[jid];
        console.error('[OpenRouter] erro:', errIA.response?.data?.error?.message || errIA.message);
        await sock.sendMessage(jid, { text: '⚠️ Não consegui obter uma resposta da IA agora. Tente novamente mais tarde.' });
    }
}

async function gerarAudioGoogle(texto) {
    const urlAudio = googleTTS.getAudioUrl(texto, {
        lang: 'pt-BR',
        slow: false,
        host: 'https://translate.google.com'
    });
    const resposta = await axios.get(urlAudio, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8'
        }
    });
    return Buffer.from(resposta.data);
}

function converterParaOpus(audioMp3) {
    return new Promise((resolve, reject) => {
        const entrada = new PassThrough();
        const partes = [];
        entrada.end(audioMp3);

        fluentFfmpeg(entrada)
            .audioCodec('libopus')
            .audioBitrate('32k')
            .audioChannels(1)
            .format('ogg')
            .outputOptions('-application voip')
            .on('error', reject)
            .on('end', () => resolve(Buffer.concat(partes)))
            .pipe()
            .on('data', (parte) => partes.push(parte));
    });
}

function converterParaStickerAnimado(videoBuffer) {
    return new Promise((resolve, reject) => {
        const entrada = new PassThrough();
        const partes = [];
        const saida = fluentFfmpeg(entrada)
            .noAudio()
            .videoFilters([
                'fps=15',
                'scale=512:512:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos',
                'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black',
                'setsar=1'
            ])
            .outputOptions(['-c:v libwebp', '-lossless 0', '-q:v 50', '-compression_level 4', '-loop 0', '-t 10'])
            .format('webp')
            .on('error', reject)
            .on('end', () => {
                const bufferWebp = Buffer.concat(partes);
                if (!bufferWebp.length) return reject(new Error('FFmpeg não gerou a figurinha.'));
                resolve(bufferWebp);
            })
            .pipe();

        saida.on('data', (parte) => partes.push(parte));
        entrada.end(videoBuffer);
    });
}

function salvarAnunciosLinks() {
    fs.writeFileSync(caminhoAnunciosLinks, JSON.stringify(anunciosLinks, null, 2));
}

async function enviarAvisoAberturaFechamento(sock, grupoJid, tipo) {
    const textos = tipo === 'abertura' ? textosAberturaPorGrupo : textosFechamentoPorGrupo;
    const textoPadrao = tipo === 'abertura'
        ? '🌞 Bom dia, pessoal! O grupo está aberto novamente. Tenham um ótimo dia!'
        : '🌙 Boa noite, pessoal! O grupo está fechado para descanso. Durmam bem e até amanhã!';
    const texto = textos[grupoJid] || textoPadrao;

    if (imagemSono) {
        await sock.sendMessage(grupoJid, { image: imagemSono, caption: texto });
    } else {
        await sock.sendMessage(grupoJid, { text: texto });
    }
}

async function pedirXerife(sock, jogo) {
        jogo.aguardando = 'sheriff';
        await sock.sendMessage(jogo.xerife, {
            text: `⭐ *XERIFE*, quem você acha que é o assassino?\n\nJogadores:\n${jogo.jogadores.map(j => '• ' + j.nome).join('\n')}\n\nResponda: *.apontar <nome>*`
        });
    }

    async function pedirAssassino(sock, jogo) {
        jogo.aguardando = 'assassino';
        await sock.sendMessage(jogo.assassino, {
            text: `🔪 *ASSASSINO*, quem você deve matar?\n\nAlvos:\n${jogo.jogadores.filter(j => j.jid !== jogo.assassino).map(j => '• ' + j.nome).join('\n')}\n\nResponda: *.apontar <nome>*`
        });
    }

    async function notificarGrupo(sock, jogo, texto) {
        if (jogo.grupo) await sock.sendMessage(jogo.grupo, { text: texto });
    }

    async function fimDeJogo(sock, jogo, vencedor) {
        jogo.emAndamento = false;
        jogo.aguardando = null;
        await notificarGrupo(sock, jogo, vencedor);
        jogoCidade = { ativo: false, emAndamento: false, jogadores: [], assassino: null, xerife: null, aguardando: null, grupo: null };
    }
async function checarNovosTikToks(sockInstance) {
    for (const [grupoJid, alerta] of Object.entries(alertasTikTok)) {
        try {
            const video = await buscarUltimoVideoTikTok(alerta.username);
            if (video.id && video.id !== alerta.ultimoVideoId) {
                alerta.ultimoVideoId = video.id;
                await sockInstance.sendMessage(grupoJid, {
                    text: `🎵 *NOVO VÍDEO NO TIKTOK!*\n\n👤 Perfil: @${alerta.username}\n📹 *${video.titulo}*\n\n🔗 ${video.link}`
                });
            }
        } catch (err) {
            console.error(`[TikTok Alert] @${alerta.username}:`, err.message);
        }
    }
}

// --- SINCRONIZAÇÃO GITHUB ---
async function syncEstadoBotToGithub() {
    const config = { token: process.env.GITHUB_TOKEN, owner: 'Jackreality2', repo: 'servidor', path: 'bot_state.json' };
    if (!config.token) {
        console.error('❌ GitHub sync: variável GITHUB_TOKEN ausente.');
        return false;
    }
    const headers = { 'Authorization': `Bearer ${config.token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AtrinoBot-Sync' };
    const executarSync = async () => {
        const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
        const maxTentativas = 3;

        for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
            try {
                let sha;
                try {
                    sha = (await axios.get(url, { headers })).data.sha;
                } catch (err) {
                    if (err.response?.status !== 404) throw err;
                }

                const payload = {
                    gruposRegistrados, grupoTriagemAtivo, gruposTriagemPorCodigo, triagensAtivasPorCodigo,
                    agendamentos, pontosSorteio, sorteiosAtivosPorGrupo, sorteiosContagemPorGrupo,
                    textosAberturaPorGrupo, textosFechamentoPorGrupo, grupoLocalOcorrencias,
                    gruposOcorrenciaAtivos, alugueisPendentes, alugueisAtivosPorGrupo,
                    atualizadoEm: new Date().toISOString()
                };
                await axios.put(url, {
                    message: `Update bot state: ${new Date().toISOString()}`,
                    content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
                    sha
                }, { headers });
                console.log('✅ Estado sincronizado com GitHub.');
                return true;
            } catch (err) {
                if (err.response?.status === 409 && tentativa < maxTentativas) {
                    console.warn(`⚠️ Conflito ao salvar estado no GitHub (409); atualizando SHA e tentando novamente (${tentativa}/${maxTentativas - 1}).`);
                    continue;
                }
                console.error(`❌ GitHub sync falhou (${err.response?.status || 'sem resposta'}):`, err.response?.data?.message || err.message);
                return false;
            }
        }
        return false;
    };

    const syncEnfileirado = filaSyncGithub.then(executarSync, executarSync);
    filaSyncGithub = syncEnfileirado.then(() => undefined, () => undefined);
    return syncEnfileirado;
}

async function loadEstadoBotFromGithub() {
    const config = { token: process.env.GITHUB_TOKEN, owner: 'Jackreality2', repo: 'servidor', path: 'bot_state.json' };
    if (!config.token) return;
    const headers = { 'Authorization': `Bearer ${config.token}`, 'User-Agent': 'AtrinoBot-Sync' };
    try {
        const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
        const res = await axios.get(url, { headers });
        const payload = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf-8'));
        gruposRegistrados = Array.isArray(payload.gruposRegistrados) ? payload.gruposRegistrados : [];
        if (payload.alugueisPendentes && typeof payload.alugueisPendentes === 'object' && !Array.isArray(payload.alugueisPendentes)) {
            alugueisPendentes = payload.alugueisPendentes;
        }
        if (payload.alugueisAtivosPorGrupo && typeof payload.alugueisAtivosPorGrupo === 'object' && !Array.isArray(payload.alugueisAtivosPorGrupo)) {
            alugueisAtivosPorGrupo = payload.alugueisAtivosPorGrupo;
        }
        grupoTriagemAtivo = payload.grupoTriagemAtivo || null;
        if (Array.isArray(payload.agendamentos)) {
            agendamentos = payload.agendamentos.map((ag) => ({
                ...ag,
                recorrente: ag.recorrente === true,
                criadoEm: Number(ag.criadoEm) || Date.now(),
                fechado: Boolean(ag.fechado),
                aberto: Boolean(ag.aberto),
                executado: Boolean(ag.executado),
                ultimoFechamento: ag.ultimoFechamento || null,
                ultimaAbertura: ag.ultimaAbertura || null
            }));
        }
        if (payload.pontosSorteio && typeof payload.pontosSorteio === 'object' && !Array.isArray(payload.pontosSorteio)) {
            pontosSorteio = payload.pontosSorteio;
        }
        if (payload.sorteiosAtivosPorGrupo && typeof payload.sorteiosAtivosPorGrupo === 'object' && !Array.isArray(payload.sorteiosAtivosPorGrupo)) {
            sorteiosAtivosPorGrupo = payload.sorteiosAtivosPorGrupo;
        }
        if (payload.sorteiosContagemPorGrupo && typeof payload.sorteiosContagemPorGrupo === 'object' && !Array.isArray(payload.sorteiosContagemPorGrupo)) {
            sorteiosContagemPorGrupo = payload.sorteiosContagemPorGrupo;
        }
        if (payload.textosAberturaPorGrupo && typeof payload.textosAberturaPorGrupo === 'object' && !Array.isArray(payload.textosAberturaPorGrupo)) {
            textosAberturaPorGrupo = payload.textosAberturaPorGrupo;
        }
        if (payload.textosFechamentoPorGrupo && typeof payload.textosFechamentoPorGrupo === 'object' && !Array.isArray(payload.textosFechamentoPorGrupo)) {
            textosFechamentoPorGrupo = payload.textosFechamentoPorGrupo;
        }
        grupoLocalOcorrencias = typeof payload.grupoLocalOcorrencias === 'string' ? payload.grupoLocalOcorrencias : null;
        if (payload.gruposOcorrenciaAtivos && typeof payload.gruposOcorrenciaAtivos === 'object' && !Array.isArray(payload.gruposOcorrenciaAtivos)) {
            gruposOcorrenciaAtivos = payload.gruposOcorrenciaAtivos;
        }
        if (payload.gruposTriagemPorCodigo && typeof payload.gruposTriagemPorCodigo === 'object' && !Array.isArray(payload.gruposTriagemPorCodigo)) {
            Object.assign(gruposTriagemPorCodigo, payload.gruposTriagemPorCodigo);
            for (const [codigo, grupoJid] of Object.entries(gruposTriagemPorCodigo)) {
                const ativo = payload.triagensAtivasPorCodigo?.[codigo] !== false;
                triagensAtivasPorCodigo[codigo] = ativo;
                obterEstadoTriagem(grupoJid).ativa = ativo;
            }
        }
        console.log('✅ Estado carregado do GitHub.');
    } catch { console.log('ℹ️ Nenhum estado salvo no GitHub.'); }
}

// --- ANAGRAMA ---
const listaPalavras = ["computador","whatsapp","javascript","teclado","celular","inteligencia","programador","saturno","banana","guitarra","futebol","universo"];
function gerarAnagrama() {
    const palavra = listaPalavras[Math.floor(Math.random() * listaPalavras.length)];
    let arr = palavra.split('');
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return { original: palavra, embaralhada: arr.join('').toUpperCase() };
}

// ============================================================
// FILA SEQUENCIAL
// ============================================================
async function enviarProximaTriagemAoGrupo(sockInstance, estado = null) {
    const filaEmAnaliseAtual = estado ? estado.filaEmAnalise : filaEmAnalise;
    const filaPendenteAtual = estado ? estado.filaPendente : filaPendente;
    if (filaEmAnaliseAtual) return;
    if (!filaPendenteAtual.length) return;

    const proxima = filaPendenteAtual.shift();
    const responsavelAtual = estado ? estado.responsavel : sessaoTriagemResponsavel;
    const responsavelApelido = responsavelAtual && adminsTriagem[responsavelAtual]
        ? adminsTriagem[responsavelAtual].apelido
        : 'Não definido';

    const entradaEmAnalise = {
        ticket: proxima.ticket,
        senderJid: proxima.senderJid,
        numeroExibir: proxima.numeroExibir,
        status: 'aguardando'
    };
    if (estado) estado.filaEmAnalise = entradaEmAnalise;
    else filaEmAnalise = entradaEmAnalise;

    const sessao = proxima.sessao;
    const numeroExibir = proxima.numeroExibir;
    const grupoDestino = estado ? estado.grupoJid : grupoTriagemAtivo;

    try {
        await sockInstance.sendMessage(grupoDestino, {
            text: `📋 *TRIAGEM #${proxima.ticket}*\n\n📱 Número: ${numeroExibir}\n📲 WhatsApp: ${proxima.senderJid.split('@')[0]}\n👔 Responsável: ${responsavelApelido}\n\n${montarResumoTriagem(sessao)}\n\nUse *.aprovar ${proxima.ticket}* ou *.reprovar ${proxima.ticket}*`
        });

        for (let i = 0; i < sessao.imagens.length; i++) {
            try {
                await sockInstance.sendMessage(grupoDestino, {
                    document: sessao.imagens[i], mimetype: 'image/jpeg',
                    fileName: `print_${numeroExibir}_${i + 1}.jpg`,
                    caption: `🖼️ Print ${i + 1} — ${numeroExibir}`
                });
            } catch {}
        }
        for (let i = 0; i < sessao.audios.length; i++) {
            try {
                await sockInstance.sendMessage(grupoDestino, {
                    document: sessao.audios[i], mimetype: 'audio/mpeg',
                    fileName: `audio_${numeroExibir}_${i + 1}.mp3`,
                    caption: `🎧 Áudio ${i + 1} — ${numeroExibir}`
                });
            } catch {}
        }
    } catch (err) {
        console.error('[fila] Erro ao enviar triagem ao grupo:', err.message);
    }
}

// ============================================================
// SERVIDOR WEB (QR + painel + STATUS + PING)
// ============================================================
const PORT = parseInt(process.env.PORT, 10) || 7860;

async function criarPagamentoAluguel(sock, comprador, email) {
    const fluxo = fluxosAluguel[comprador];
    if (!fluxo || fluxo.expiraEm < Date.now()) {
        delete fluxosAluguel[comprador];
        await sock.sendMessage(comprador, { text: '⚠️ Seu pedido de aluguel expirou. Envie *.alugar* no grupo novamente.' });
        return;
    }

    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
    if (!accessToken) {
        console.error('[alugar] Configure MERCADOPAGO_ACCESS_TOKEN no ambiente.');
        await sock.sendMessage(comprador, { text: '❌ O aluguel ainda não está configurado. Avise o administrador do bot.' });
        return;
    }

    const referencia = randomUUID();
    const registro = {
        comprador,
        grupoJid: fluxo.grupoJid,
        valor: PRECO_ALUGUEL_MENSAL,
        status: 'pending',
        criadoEm: Date.now()
    };
    alugueisPendentes[referencia] = registro;
    if (!await syncEstadoBotToGithub()) {
        delete alugueisPendentes[referencia];
        await sock.sendMessage(comprador, { text: '❌ Não foi possível registrar o pedido com segurança. Tente novamente mais tarde.' });
        return;
    }

    let pagamento;
    try {
        const resposta = await axios.post('https://api.mercadopago.com/v1/payments', {
            transaction_amount: PRECO_ALUGUEL_MENSAL,
            description: 'Aluguel mensal do bot',
            payment_method_id: 'pix',
            payer: { email },
            external_reference: referencia
        }, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': referencia
            },
            timeout: 20000
        });
        pagamento = resposta.data;
    } catch (err) {
        console.error('[alugar] erro ao criar pagamento no Mercado Pago:',
            err.response?.data?.message || err.message);
        delete alugueisPendentes[referencia];
        if (!await syncEstadoBotToGithub()) {
            console.error('[alugar] não foi possível remover o pedido que falhou da persistência.');
        }
        await sock.sendMessage(comprador, { text: '❌ Não consegui gerar o Pix agora. Confira seu e-mail e tente novamente em alguns minutos.' });
        return;
    }

    const dadosPix = pagamento?.point_of_interaction?.transaction_data;
    if (!pagamento?.id || !dadosPix?.qr_code || !dadosPix?.qr_code_base64) {
        console.error('[alugar] resposta do Mercado Pago sem os dados de QR Pix esperados.');
        await sock.sendMessage(comprador, { text: '❌ O Mercado Pago não retornou o QR Code. Avise o administrador antes de tentar pagar.' });
        return;
    }

    registro.paymentId = String(pagamento.id);
    if (!await syncEstadoBotToGithub()) {
        delete alugueisPendentes[referencia];
        if (!await syncEstadoBotToGithub()) {
            console.error('[alugar] não foi possível remover o pedido cujo ID não foi salvo.');
        }
        await sock.sendMessage(comprador, { text: '❌ Não consegui salvar o pedido para acompanhar o pagamento. Não pague este QR; tente novamente mais tarde.' });
        return;
    }

    delete fluxosAluguel[comprador];
    const imagemBase64 = dadosPix.qr_code_base64.replace(/^data:image\/png;base64,/, '');
    await sock.sendMessage(comprador, {
        image: Buffer.from(imagemBase64, 'base64'),
        caption: `💳 *Pix do aluguel do bot*\n\n💰 Valor: *R$ ${PRECO_ALUGUEL_MENSAL.toFixed(2).replace('.', ',')}*\n📅 Período: *30 dias*\n\nEscaneie o QR Code para pagar. O grupo será liberado automaticamente após a confirmação do Mercado Pago.`
    });
    await sock.sendMessage(comprador, {
        text: `📋 *Pix copia e cola:*\n\n${dadosPix.qr_code}\n\n⚠️ Pedido: ${referencia.slice(0, 8)}`
    });
}

async function confirmarPagamentoAluguel(pagamento) {
    const registro = alugueisPendentes[pagamento?.external_reference];
    if (!registro || registro.status !== 'pending' ||
        pagamento.status !== 'approved' ||
        pagamento.payment_method_id !== 'pix' ||
        pagamento.currency_id !== 'BRL' ||
        Math.round(Number(pagamento.transaction_amount) * 100) !== Math.round(registro.valor * 100)) {
        return true;
    }

    const comprador = registro.comprador;
    const grupoJaRegistrado = gruposRegistrados.includes(registro.grupoJid);
    const expiracaoAnterior = alugueisAtivosPorGrupo[registro.grupoJid];
    const expiracaoNova = Math.max(Number(expiracaoAnterior) || Date.now(), Date.now()) + DURACAO_ALUGUEL_MS;
    registro.status = 'approved';
    registro.pagoEm = Date.now();
    delete registro.comprador;
    registro.expiraEm = expiracaoNova;
    alugueisAtivosPorGrupo[registro.grupoJid] = expiracaoNova;
    if (!grupoJaRegistrado) gruposRegistrados.push(registro.grupoJid);

    if (!await syncEstadoBotToGithub()) {
        registro.status = 'pending';
        registro.comprador = comprador;
        delete registro.pagoEm;
        delete registro.expiraEm;
        if (expiracaoAnterior) alugueisAtivosPorGrupo[registro.grupoJid] = expiracaoAnterior;
        else delete alugueisAtivosPorGrupo[registro.grupoJid];
        if (!grupoJaRegistrado) gruposRegistrados = gruposRegistrados.filter(id => id !== registro.grupoJid);
        return false;
    }

    const validade = new Date(expiracaoNova).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const mensagem = `✅ *Pagamento confirmado!*\n\nO aluguel do bot foi ativado/renovado no grupo por 30 dias.\n💰 Valor: R$ ${registro.valor.toFixed(2).replace('.', ',')}\n📅 Válido até: ${validade}`;
    for (const destino of [comprador, registro.grupoJid, DONO_SUPREMO]) {
        try {
            await sockAtual.sendMessage(destino, { text: mensagem });
        } catch (err) {
            console.error(`[aluguel] falha ao avisar ${destino}:`, err.message);
        }
    }
    return true;
}

async function processarWebhookMercadoPago(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
    }

    let corpo;
    try {
        const partes = [];
        let tamanho = 0;
        for await (const parte of req) {
            tamanho += parte.length;
            if (tamanho > 16384) {
                res.writeHead(413);
                res.end();
                return;
            }
            partes.push(parte);
        }
        corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
    } catch (err) {
        console.error('[Mercado Pago webhook] notificação inválida:', err.message);
        res.writeHead(400);
        res.end();
        return;
    }

    const url = new URL(req.url, 'http://localhost');
    const paymentId = corpo?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id');
    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
    if (!paymentId || !accessToken) {
        res.writeHead(paymentId ? 503 : 400);
        res.end();
        return;
    }

    try {
        const resposta = await axios.get(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000
        });
        if (!await confirmarPagamentoAluguel(resposta.data)) {
            res.writeHead(503);
            res.end();
            return;
        }

        res.writeHead(200);
        res.end();
    } catch (err) {
        console.error('[Mercado Pago webhook] falha ao confirmar pagamento:',
            err.response?.data?.message || err.message);
        res.writeHead(503);
        res.end();
    }
}

let sockAtual = null;

http.createServer(async (req, res) => {
    if (new URL(req.url, 'http://localhost').pathname === '/mercadopago/webhook') {
        await processarWebhookMercadoPago(req, res);
        return;
    }

    // --- endpoint de ping (botão da página chama aqui) ---
    if (req.url === '/ping' || req.url === '/ping?') {
        ultimoPingRecebido = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: statusConexao, timestamp: Date.now() }));
        return;
    }

    // --- endpoint de status (para a página checar) ---
    if (req.url === '/status' || req.url === '/status?') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: statusConexao, temQr: !!qrAtual, ultimoPing: ultimoPingRecebido }));
        return;
    }

    if (req.url === '/gerar-senha') {
        senhaRegistro = Math.random().toString(36).substring(2, 8).toUpperCase();
        res.writeHead(302, { 'Location': '/' }); res.end(); return;
    }

    // --- página sem QR: mostra status REAL + botão de ping ---
    if (!qrAtual) {
        const statusCor = statusConexao === 'conectado' ? '#25D366' : '#ee5253';
        const statusTxt = statusConexao === 'conectado' ? '✅ BOT ONLINE' : '⚠️ DESCONECTADO';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html><head><title>Atrino Bot</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:Arial,sans-serif;text-align:center;margin-top:40px;background:#0f0c1b;color:#00ffcc;padding:20px}
.card{background:#17142b;display:inline-block;padding:30px;border-radius:15px;border:1px solid #3d3475;max-width:95vw}
.btn{display:inline-block;margin-top:15px;padding:14px 28px;background:#00ffcc;color:#0f0c1b;text-decoration:none;border-radius:8px;font-weight:bold;border:none;cursor:pointer;font-size:16px}
.btn:hover{background:#00d9b3}
.btn-ping{background:#25D366;color:#fff;width:100%;margin-top:15px;padding:18px;font-size:18px;border:none;border-radius:10px;cursor:pointer;font-weight:bold}
.btn-ping:hover{background:#1eb855}
.btn-ping.ativo{background:#ff9800;color:#fff}
.btn-ping.parado{background:#666;color:#aaa}
.senha{font-size:1.8em;background:#111;padding:10px 20px;border-radius:10px;margin:15px 0;border:2px dashed #00ffcc;display:block}
.status-box{padding:15px;border-radius:10px;margin:15px 0;font-size:20px;font-weight:bold}
.status-online{background:rgba(37,211,102,0.15);color:#25D366;border:2px solid #25D366}
.status-offline{background:rgba(238,82,83,0.15);color:#ee5253;border:2px solid #ee5253}
.log{margin-top:15px;text-align:left;background:#0a0815;padding:12px;border-radius:8px;font-size:12px;max-height:150px;overflow-y:auto;font-family:monospace;color:#888;border:1px solid #2a2540}
.contador{font-size:14px;color:#00ffcc;margin-top:10px}
.heartbeat{font-size:13px;color:#888;margin-top:8px}
</style></head>
<body><div class="card">
<h1>🚀 Atrino Bot</h1>
<div class="status-box ${statusConexao === 'conectado' ? 'status-online' : 'status-offline'}">${statusTxt}</div>
<div class="heartbeat" id="hb">❤️ Último sinal: verificando...</div>
${senhaRegistro ? `<p>Senha:</p><span class="senha">${senhaRegistro}</span><p>.registrar ${senhaRegistro}</p>` : '<p style="color:#ee5253">Nenhuma senha ativa.</p>'}
<a href__="/gerar-senha" class="btn">🔄 GERAR SENHA</a>
<hr style="margin:20px 0;border-color:#3d3475">
<h3>📡 Keep-Alive (Ping)</h3>
<button id="btnPing" class="btn-ping" onclick="togglePing()">▶️ INICIAR PING</button>
<div class="contador" id="contador">Pings enviados: 0</div>
<div class="log" id="log">[log] Aguardando início...</div>
</div>
<script>
let pingInterval = null;
let pingCount = 0;
const btn = document.getElementById('btnPing');
const log = document.getElementById('log');
const contador = document.getElementById('contador');

function addLog(msg) {
    const t = new Date().toLocaleTimeString('pt-BR');
    log.innerHTML = '[' + t + '] ' + msg + '<br>' + log.innerHTML;
    if (log.innerHTML.length > 2000) log.innerHTML = log.innerHTML.substring(0, 2000);
}

async function enviarPing() {
    try {
        const resp = await fetch('/ping', { cache: 'no-store' });
        const data = await resp.json();
        pingCount++;
        contador.innerHTML = 'Pings enviados: ' + pingCount + ' | Status: ' + (data.status || '?');
        addLog('✅ Ping #' + pingCount + ' OK — ' + data.status);
    } catch (e) {
        addLog('❌ Falhou: ' + e.message);
    }
}

function togglePing() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
        btn.className = 'btn-ping parado';
        btn.innerHTML = '▶️ INICIAR PING';
        addLog('⏹️ Ping parado');
    } else {
        enviarPing();
        pingInterval = setInterval(enviarPing, 20000);
        btn.className = 'btn-ping ativo';
        btn.innerHTML = '⏸️ PARAR PING';
        addLog('🟢 Ping iniciado (a cada 20s)');
    }
}

// checa status no servidor a cada 10s
setInterval(async () => {
    try {
        const r = await fetch('/status', { cache: 'no-store' });
        const d = await r.json();
        const hb = document.getElementById('hb');
        const ago = Math.round((Date.now() - d.ultimoPing) / 1000);
        hb.innerHTML = '❤️ Último sinal: ' + ago + 's atrás';
    } catch {}
}, 10000);
</script>
</body></html>`);
        return;
    }

    // --- página com QR ---
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><title>Atrino Bot - QR</title>
<meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{font-family:Arial;text-align:center;margin-top:50px;background:#0f0c1b;color:#fff;padding:20px}
h1{color:#25D366}
.qr{border:10px solid white;border-radius:10px;max-width:90vw;width:300px}
.status-box{padding:12px;border-radius:10px;margin:15px auto;max-width:300px;font-weight:bold;background:rgba(255,152,0,0.15);color:#ff9800;border:2px solid #ff9800}
</style></head>
<body><h1>📱 Escaneie o QR Code</h1>
<div class="status-box">⏳ Aguardando conexão...</div>
<img class="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrAtual)}"/>
<p style="color:#888;margin-top:20px;font-size:14px">Atualiza em 5s automaticamente</p>
</body></html>`);
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🛰️ Servidor ativo na porta ${PORT}`);
    // ping interno (mantém processo ativo)
    setInterval(() => { http.get(`http://localhost:${PORT}/ping`).on('error', () => {}); }, 30000);
});

async function baixarMidiaDoMensagem(sock, message) {
    if (message.imageMessage) {
        const stream = await downloadContentFromMessage(message.imageMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return { tipo: 'image', buffer };
    }
    const audioMessage = message.audioMessage || message.ptt;
    if (audioMessage) {
        const stream = await downloadContentFromMessage(audioMessage, 'audio');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return { tipo: 'audio', buffer };
    }
    return null;
}

function gerarHorariosDisponiveis() {
    const agora = new Date();
    const slots = [];
    for (let i = 0; i < 6; i++) {
        const d = new Date(agora.getTime() + i * 30 * 60 * 1000);
        const h = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        slots.push(h);
    }
    return slots;
}

function criarBaralhoUno() {
    const baralho = [];
    for (const cor of UNO_CORES) {
        baralho.push({ cor, valor: '0' });
        for (let n = 1; n <= 9; n++) { baralho.push({ cor, valor: String(n) }); baralho.push({ cor, valor: String(n) }); }
        baralho.push({ cor, valor: 'skip' }); baralho.push({ cor, valor: 'skip' });
        baralho.push({ cor, valor: 'reverse' }); baralho.push({ cor, valor: 'reverse' });
        baralho.push({ cor, valor: '+2' }); baralho.push({ cor, valor: '+2' });
    }
    for (let i = 0; i < 4; i++) { baralho.push({ cor: 'wild', valor: 'wild' }); baralho.push({ cor: 'wild', valor: '+4' }); }
    for (let i = baralho.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [baralho[i], baralho[j]] = [baralho[j], baralho[i]]; }
    return baralho;
}

function descCarta(c) {
    if (c.valor === 'skip') return `🚫 Bloquear ${UNO_COR_EMOJI[c.cor]}`;
    if (c.valor === 'reverse') return `⇄ Inverter ${UNO_COR_EMOJI[c.cor]}`;
    if (c.valor === '+2') return `+2 ${UNO_COR_EMOJI[c.cor]}`;
    if (c.valor === 'wild') return `🎨 Coringa`;
    if (c.valor === '+4') return `+4 Coringa 🎨`;
    return `${c.valor} ${UNO_COR_EMOJI[c.cor]}`;
}

async function enviarCartaSticker(sock, jidDest, carta, jogo) {
    const hex = UNO_COR_HEX[carta.cor];
    const txtCor = (carta.cor === 'yellow') ? '000000' : 'ffffff';
    let texto;
    if (carta.valor === 'skip') texto = 'SKIP';
    else if (carta.valor === 'reverse') texto = 'REV';
    else texto = carta.valor;
    const url = `https://dummyimage.com/300x450/${hex}/${txtCor}.png&text=${encodeURIComponent(texto)}`;
    try {
        const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        const buffer = Buffer.from(resp.data, 'binary');
        const sticker = new Sticker(buffer, { pack: 'Atrino UNO', author: 'AtrinoBot', type: StickerTypes.FULL, quality: 60 });
        const sent = await sock.sendMessage(jidDest, await sticker.toMessage());
        const stk = sent?.message?.stickerMessage;
        if (stk?.fileSha256) jogo.cartasPorHash[stk.fileSha256.toString('base64')] = { cor: carta.cor, valor: carta.valor };
    } catch (e) { console.error('[uno] erro sticker:', e.message); }
}

function cartaCombina(carta, topo, corAtual) {
    if (carta.cor === 'wild') return true;
    if (carta.cor === corAtual) return true;
    if (topo && carta.valor === topo.valor) return true;
    return false;
}

function proxIdx(jogo) { return (jogo.jogadorVez + jogo.sentido + jogo.jogadores.length) % jogo.jogadores.length; }

function recapCartas(jogo) {
    return jogo.jogadores.map((j, i) => `${i === jogo.jogadorVez ? '👉 ' : '   '}${j.nome}: ${j.mao.length} carta(s)`).join('\n');
}

async function anunciarVezUno(sock, jogo) {
    const j = jogo.jogadores[jogo.jogadorVez];
    const topo = jogo.descarte[jogo.descarte.length - 1];
    await sock.sendMessage(jogo.grupo, {
        text: `🃏 *UNO — Vez de ${j.nome}*\n\n🔝 Topo: ${descCarta(topo)}\n🎨 Cor: ${UNO_COR_EMOJI[jogo.corAtual]} ${UNO_CORES_PT[jogo.corAtual]}\n\n📊 *Cartas:*\n${recapCartas(jogo)}\n\nEnvie a figurinha da carta ou *.puxar* para comprar.`
    });
}

async function processarJogadaUno(sock, sender, hash, jid) {
    const jogo = unoGame;
    const jogador = jogo.jogadores[jogo.jogadorVez];
    if (jogador.jid !== sender) return sock.sendMessage(jid, { text: `⏳ Não é sua vez! Vez de *${jogador.nome}*.` });
    const carta = jogo.cartasPorHash[hash];
    if (!carta) return;
    const idx = jogador.mao.findIndex(c => c.cor === carta.cor && c.valor === carta.valor);
    if (idx === -1) return sock.sendMessage(jid, { text: `❌ Você não tem essa carta na mão!` });
    const topo = jogo.descarte[jogo.descarte.length - 1];
    if (!cartaCombina(carta, topo, jogo.corAtual)) return sock.sendMessage(jid, { text: `❌ Não combina! Precisa ${UNO_COR_EMOJI[jogo.corAtual]} ${UNO_CORES_PT[jogo.corAtual]} ou ${descCarta(topo)}.` });

    jogador.mao.splice(idx, 1);
    jogo.descarte.push(carta);

    if (jogador.mao.length === 0) {
        jogo.emAndamento = false;
        await sock.sendMessage(jid, { text: `🏆 *${jogador.nome} VENCEU O UNO!* 🎉\n\n${recapCartas(jogo)}` });
        unoGame = { ativo: false, emAndamento: false, jogadores: [], baralho: [], descarte: [], jogadorVez: 0, corAtual: null, sentido: 1, grupo: null, cartasPorHash: {}, aguardandoCor: null, pularAposCor: false };
        return;
    }
    if (jogador.mao.length === 1) await sock.sendMessage(jid, { text: `🔥 *UNO!* ${jogador.nome} tem só 1 carta!` });

    let avancar = true;
    if (carta.valor === 'skip') {
        const prox = jogo.jogadores[proxIdx(jogo)];
        await sock.sendMessage(jid, { text: `🚫 ${prox.nome} foi bloqueado!` });
        jogo.jogadorVez = (jogo.jogadorVez + 2 * jogo.sentido + jogo.jogadores.length) % jogo.jogadores.length;
        avancar = false;
    } else if (carta.valor === 'reverse') {
        jogo.sentido *= -1;
        await sock.sendMessage(jid, { text: `⇄ Sentido invertido!` });
        if (jogo.jogadores.length === 2) { jogo.jogadorVez = (jogo.jogadorVez + 2 * jogo.sentido + jogo.jogadores.length) % jogo.jogadores.length; avancar = false; }
    } else if (carta.valor === '+2') {
        const prox = jogo.jogadores[proxIdx(jogo)];
        for (let i = 0; i < 2; i++) { if (!jogo.baralho.length) jogo.baralho = criarBaralhoUno(); const c = jogo.baralho.pop(); prox.mao.push(c); await enviarCartaSticker(sock, prox.jid, c, jogo); }
        await sock.sendMessage(prox.jid, { text: `📥 Você comprou 2 cartas (+2 de ${jogador.nome})!` });
        await sock.sendMessage(jid, { text: `📥 ${prox.nome} comprou 2 e perdeu a vez!` });
        jogo.jogadorVez = (jogo.jogadorVez + 2 * jogo.sentido + jogo.jogadores.length) % jogo.jogadores.length;
        avancar = false;
    } else if (carta.valor === 'wild') {
        jogo.aguardandoCor = sender; jogo.pularAposCor = false;
        await sock.sendMessage(jid, { text: `🎨 ${jogador.nome} jogou Coringa! Escolha: *.cor vermelho/azul/amarelo/verde*` });
        return;
    } else if (carta.valor === '+4') {
        const prox = jogo.jogadores[proxIdx(jogo)];
        for (let i = 0; i < 4; i++) { if (!jogo.baralho.length) jogo.baralho = criarBaralhoUno(); const c = jogo.baralho.pop(); prox.mao.push(c); await enviarCartaSticker(sock, prox.jid, c, jogo); }
        await sock.sendMessage(prox.jid, { text: `📥 Você comprou 4 cartas (+4 Coringa)!` });
        await sock.sendMessage(jid, { text: `🎨 ${jogador.nome} jogou +4! ${prox.nome} comprou 4.\n\n${jogador.nome}, escolha: *.cor vermelho/azul/amarelo/verde*` });
        jogo.aguardandoCor = sender; jogo.pularAposCor = true;
        return;
    }

    if (carta.cor !== 'wild') jogo.corAtual = carta.cor;
    if (avancar) jogo.jogadorVez = proxIdx(jogo);
    await anunciarVezUno(sock, jogo);
}

async function startAtrinoBot() {
    console.log(`[GitHub] GITHUB_TOKEN no início: ${process.env.GITHUB_TOKEN?.trim() ? 'presente' : 'ausente'}.`);
    await loadEstadoBotFromGithub();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        logger, auth: state, printQRInTerminal: false,
        browser: ['Mac OS', 'Chrome', '121.0.0.0'],
        connectTimeoutMs: 120000, keepAliveIntervalMs: 30000,
        markOnline: true, shouldSyncHistoryMessage: () => false,
        receivedPendingNotifications: false,
    });
    sockAtual = sock;
    const enviarMensagemOriginal = sock.sendMessage.bind(sock);
    sock.sendMessage = async (destino, conteudo, opcoes) => {
        const resultado = await enviarMensagemOriginal(destino, conteudo, opcoes);
        try {
            analiseDiaria.registrarMensagem({
                conversa: destino,
                autor: 'bot',
                direcao: 'enviada',
                texto: extrairTextoEnviado(conteudo),
                tipoMidia: identificarTipoMidia(conteudo)
            });
        } catch (erroHistorico) {
            console.error('[documento] falha ao salvar mensagem enviada no histórico:', erroHistorico.message);
        }
        return resultado;
    };

    sock.ev.on('creds.update', saveCreds);

    // --- BOAS-VINDAS ---
    sock.ev.on('group-participants.update', async (anu) => {
        if (anu.action === 'add') {
            if (!datasEntradaGrupo[anu.id]) datasEntradaGrupo[anu.id] = {};
            for (const participant of anu.participants) {
                datasEntradaGrupo[anu.id][participant] = Date.now();
            }
            if (!notificacoesAtivas[anu.id]) return;
            for (const participant of anu.participants) {
                // === BLACKLIST: remove automaticamente se retornar ===
                if (blacklist[anu.id]?.includes(participant)) {
                    try {
                        await sock.groupParticipantsUpdate(anu.id, [participant], 'remove');
                        await sock.sendMessage(anu.id, {
                            text: `🚫 @${participant.split('@')[0]} está na *BLACKLIST* e foi removido automaticamente.`,
                            mentions: [participant]
                        });
                    } catch (err) { console.error('[blacklist] erro:', err.message); }
                    continue;
                }

                let ppUrl;
                try { ppUrl = await sock.profilePictureUrl(participant, 'image'); }
                catch { ppUrl = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png'; }
                await sock.sendMessage(anu.id, {
                    image: { url: ppUrl },
                    caption: `╭─── [ ✨ *NOVO MEMBRO* ] ───╮\n│\n│  🌟 *Seja bem-vindo(a)!*\n│  👤 @${participant.split('@')[0]}\n│\n│  ➥ Leia as regras!\n╰─────────────────────╯`,
                    mentions: [participant]
                });
            }
        }
        if (anu.action === 'request') {
            const solicitante = anu.participants[0];
            solicitacoesPendentes[anu.id] = solicitante;
            await sock.sendMessage(anu.id, {
                text: `🔔 *SOLICITAÇÃO DE ENTRADA*\n\n👤 @${solicitante.split('@')[0]}\n\n*.aceitar* para aprovar | *.recusar* para barrar.`,
                mentions: [solicitante]
            });
        }
    });

    // --- CRONS ---
    cron.schedule('0 0 * * *', async () => {
        try {
            await sock.groupSettingUpdate(ID_DO_GRUPO, 'announcement');
            await enviarAvisoAberturaFechamento(sock, ID_DO_GRUPO, 'fechamento');
        } catch (err) {
            console.error('[sono] falha ao fechar grupo fixo:', err.message);
        }
    }, { timezone: 'America/Sao_Paulo' });

    cron.schedule('0 4 * * *', async () => {
        try {
            await sock.groupSettingUpdate(ID_DO_GRUPO, 'not_announcement');
            await enviarAvisoAberturaFechamento(sock, ID_DO_GRUPO, 'abertura');
        } catch (err) {
            console.error('[acordar] falha ao abrir grupo fixo:', err.message);
        }
    }, { timezone: 'America/Sao_Paulo' });

    cron.schedule('*/5 * * * *', async () => {
        if (Object.keys(alertasTikTok).length > 0) await checarNovosTikToks(sock);
    });

    cron.schedule('*/3 * * * *', async () => {
        if (sorteioEmExecucao) return;
        sorteioEmExecucao = true;
        let pontuacaoAlterada = false;
        try {
            const gruposSorteio = Object.entries(sorteiosAtivosPorGrupo)
                .filter(([, ativo]) => ativo === true)
                .map(([grupoJid]) => grupoJid);
            const botJidSorteio = jidNormalizedUser(sock.user?.id || '');

            for (const grupoJid of gruposSorteio) {
                try {
                    const metaSorteio = await sock.groupMetadata(grupoJid);
                    const participantes = metaSorteio.participants
                        .map((participante) => participante.id)
                        .filter((participanteJid) => participanteJid !== botJidSorteio);
                    if (!participantes.length) continue;

                    await sock.sendMessage(grupoJid, { text: '🎲 O bot vai sortear alguém para ganhar 1 ponto no ranking...' });
                    await new Promise((resolve) => setTimeout(resolve, 1200));

                    if (!sorteiosContagemPorGrupo[grupoJid]) sorteiosContagemPorGrupo[grupoJid] = {};
                    const contagensGrupo = sorteiosContagemPorGrupo[grupoJid];
                    const obterContagemSorteios = (participanteJid) => {
                        const contagem = Number(contagensGrupo[participanteJid]);
                        return Number.isSafeInteger(contagem) && contagem >= 0 ? contagem : 0;
                    };
                    const menorContagem = Math.min(...participantes.map(obterContagemSorteios));
                    const candidatosSorteio = participantes.filter(
                        (participanteJid) => obterContagemSorteios(participanteJid) === menorContagem
                    );
                    const vencedorSorteio = candidatosSorteio[Math.floor(Math.random() * candidatosSorteio.length)];
                    if (!pontosSorteio[grupoJid]) pontosSorteio[grupoJid] = {};
                    pontosSorteio[grupoJid][vencedorSorteio] = (pontosSorteio[grupoJid][vencedorSorteio] || 0) + 1;
                    const contagemAtual = Number(contagensGrupo[vencedorSorteio]);
                    contagensGrupo[vencedorSorteio] =
                        (Number.isSafeInteger(contagemAtual) && contagemAtual >= 0 ? contagemAtual : 0) + 1;
                    pontuacaoAlterada = true;
                    await sock.sendMessage(grupoJid, {
                        text: `🎉 Sorteado: @${vencedorSorteio.split('@')[0]} ganhou 1 ponto!\nUse *.ranking* para ver a classificação.`,
                        mentions: [vencedorSorteio]
                    });
                } catch (errSorteio) {
                    console.error(`[sorteio] falha no grupo ${grupoJid}:`, errSorteio.message);
                }
            }

            if (pontuacaoAlterada) await syncEstadoBotToGithub();
        } catch (errSorteio) {
            console.error('[sorteio] erro geral:', errSorteio.message);
        } finally {
            sorteioEmExecucao = false;
        }
    }, { timezone: 'America/Sao_Paulo' });

    cron.schedule('* * * * *', async () => {
        const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
        if (!accessToken || verificacaoAluguelEmAndamento) return;
        verificacaoAluguelEmAndamento = true;
        try {
            for (const registro of Object.values(alugueisPendentes)) {
                if (registro.status !== 'pending' || !registro.paymentId) continue;
                try {
                    const resposta = await axios.get(
                        `https://api.mercadopago.com/v1/payments/${encodeURIComponent(registro.paymentId)}`,
                        {
                            headers: { Authorization: `Bearer ${accessToken}` },
                            timeout: 15000
                        }
                    );
                    if (!await confirmarPagamentoAluguel(resposta.data)) {
                        console.error(`[aluguel] falha ao salvar confirmação do pagamento ${registro.paymentId}; será verificado novamente.`);
                    }
                } catch (err) {
                    console.error(`[aluguel] erro ao consultar pagamento ${registro.paymentId}:`,
                        err.response?.data?.message || err.message);
                }
            }
        } finally {
            verificacaoAluguelEmAndamento = false;
        }
    }, { timezone: 'America/Sao_Paulo' });

    cron.schedule('* * * * *', async () => {
        const agoraExpiracao = Date.now();
        for (const [grupoJid, expiraEm] of Object.entries(alugueisAtivosPorGrupo)) {
            if (Number(expiraEm) > agoraExpiracao) continue;
            const grupoEstavaRegistrado = gruposRegistrados.includes(grupoJid);
            delete alugueisAtivosPorGrupo[grupoJid];
            gruposRegistrados = gruposRegistrados.filter(id => id !== grupoJid);
            if (!await syncEstadoBotToGithub()) {
                alugueisAtivosPorGrupo[grupoJid] = expiraEm;
                if (grupoEstavaRegistrado && !gruposRegistrados.includes(grupoJid)) gruposRegistrados.push(grupoJid);
                continue;
            }
            const validade = new Date(Number(expiraEm)).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            for (const destino of [grupoJid, DONO_SUPREMO]) {
                try {
                    await sock.sendMessage(destino, {
                        text: `⏰ O aluguel do bot para este grupo expirou em ${validade}. Para renovar, um administrador deve enviar *.alugar* no grupo.`
                    });
                } catch (err) {
                    console.error(`[aluguel] falha ao avisar ${destino} sobre expiração:`, err.message);
                }
            }
        }
    }, { timezone: 'America/Sao_Paulo' });

    cron.schedule('* * * * *', async () => {
        const agoraCron = Date.now();
        const limiteInatividade = 30 * 24 * 60 * 60 * 1000;

        for (const [grupoJid, ativo] of Object.entries(inativoAtivo)) {
            if (!ativo) continue;
            try {
                const meta = await sock.groupMetadata(grupoJid);
                const botJid = jidNormalizedUser(sock.user.id);
                for (const p of meta.participants) {
                    if (p.id === botJid || p.admin || p.id === DONO_SUPREMO || p.id === DONO_ADMIN) continue;
                    const ultima = ultimaMsgGrupo[p.id] || 0;
                    if (ultima && (agoraCron - ultima) > limiteInatividade) {
                        try {
                            await sock.sendMessage(grupoJid, { text: `🧹 @${p.id.split('@')[0]} ficou 30 dias inativo e foi removido.`, mentions: [p.id] });
                            await sock.groupParticipantsUpdate(grupoJid, [p.id], 'remove');
                            delete ultimaMsgGrupo[p.id];
                        } catch (err) { console.error('[inativo] erro:', err.message); }
                    }
                }
            } catch {}
        }

        const hoje = new Date().toLocaleDateString('pt-BR', {
            timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit'
        });
        const horaAgora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

        for (const ag of agendamentos) {
            if (!ag.recorrente && ag.executado) continue;
            if (!ag.recorrente && ag.dataProg !== hoje) continue;

            const dataCriacao = ag.recorrente && ag.criadoEm
                ? new Date(ag.criadoEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })
                : null;
            const horaCriacao = ag.recorrente && ag.criadoEm
                ? new Date(ag.criadoEm).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
                : null;
            const podeFecharHoje = !ag.recorrente || dataCriacao !== hoje || ag.horaFecha >= horaCriacao;
            const podeAbrirHoje = !ag.recorrente || dataCriacao !== hoje || ag.horaAbre >= horaCriacao;
            const fechadoHoje = ag.recorrente ? ag.ultimoFechamento === hoje : ag.fechado;
            const abertoHoje = ag.recorrente ? ag.ultimaAbertura === hoje : ag.aberto;

            if (!fechadoHoje && podeFecharHoje && horaAgora >= ag.horaFecha) {
                try {
                    await sock.groupSettingUpdate(ag.grupo, 'announcement');
                    if (ag.recorrente) ag.ultimoFechamento = hoje;
                    else ag.fechado = true;
                    await syncEstadoBotToGithub();
                    try {
                        await enviarAvisoAberturaFechamento(sock, ag.grupo, 'fechamento');
                    } catch (errMsg) {
                        console.error('[programar] aviso de fechamento falhou:', errMsg.message);
                    }
                } catch (err) {
                    console.error(`[programar] falha ao fechar ${ag.grupo}:`, err.message);
                }
            }
            if (!abertoHoje && podeAbrirHoje && horaAgora >= ag.horaAbre) {
                try {
                    await sock.groupSettingUpdate(ag.grupo, 'not_announcement');
                    if (ag.recorrente) ag.ultimaAbertura = hoje;
                    else {
                        ag.aberto = true;
                        ag.executado = true;
                    }
                    await syncEstadoBotToGithub();
                    try {
                        await enviarAvisoAberturaFechamento(sock, ag.grupo, 'abertura');
                    } catch (errMsg) {
                        console.error('[programar] aviso de abertura falhou:', errMsg.message);
                    }
                } catch (err) {
                    console.error(`[programar] falha ao abrir ${ag.grupo}:`, err.message);
                }
            }
        }
    }, { timezone: 'America/Sao_Paulo' });
    
    // ============================================================
    // CONEXÃO — agora seta statusConexao (página mostra a verdade)
    // ============================================================
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrAtual = qr;
            statusConexao = 'aguardando_qr';
            console.log('\n🔗 QR: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr));
            qrcode.generate(qr, { small: false });
        }
        if (connection === 'open') {
            qrAtual = null;
            statusConexao = 'conectado';
            console.log('\n✅ ATRINO BOT ONLINE!\n');
        }
        if (connection === 'close') {
            qrAtual = null;
            statusConexao = 'desconectado';
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('🔄 Conexão fechada (código:', reason, ') - Status: DESCONECTADO');
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Reiniciando em 5s...');
                setTimeout(() => startAtrinoBot(), 5000);
            } else {
                console.log('❌ Sessão encerrada permanentemente.');
            }
        }
        if (connection === 'connecting') {
            statusConexao = statusConexao === 'conectado' ? 'desconectado' : statusConexao;
        }
    });

    // ============================================================
    // HANDLER PRINCIPAL DE MENSAGENS
    // ============================================================
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages?.length) return;
        for (const mensagem of messages) {
            if (!mensagem.message || mensagem.key.fromMe) continue;
            const conversa = mensagem.key.remoteJid;
            const grupo = conversa.endsWith('@g.us');
            const autor = grupo ? (mensagem.key.participant || conversa) : conversa;
            const texto = extrairTextoRecebido(mensagem.message);
            try {
                analiseDiaria.registrarMensagem({
                    conversa,
                    autor,
                    direcao: 'recebida',
                    texto,
                    tipoMidia: identificarTipoMidia(mensagem.message)
                });
            } catch (erroHistorico) {
                console.error('[documento] falha ao salvar mensagem recebida no histórico:', erroHistorico.message);
            }
            if (texto.startsWith('.') || texto.startsWith('cmd_')) {
                const comandoContabilizado = texto.startsWith('cmd_')
                    ? `atalho_${texto.slice(4).trim().split(/\s+/)[0] || 'desconhecido'}`
                    : texto.slice(1).trim().split(/\s+/)[0]?.toLowerCase() || 'desconhecido';
                try {
                    analiseDiaria.registrarComando(comandoContabilizado, grupo ? conversa : 'privado');
                } catch (erroRegistro) {
                    console.error('[documento] falha ao salvar uso diário de comando:', erroRegistro.message);
                }
            }
        }
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid      = m.key.remoteJid;
        const isGroup  = jid.endsWith('@g.us');
        const isDM     = !isGroup;
        const sender   = isDM ? jid : (m.key.participant || jid);
        const body     = extrairTextoRecebido(m.message);
        const contextoMensagem = m.message.extendedTextMessage?.contextInfo || {};
        const documentoPendente = documentosPendentes[jid];
        if (isGroup && documentoPendente && documentoPendente.expiraEm <= Date.now()) {
            delete documentosPendentes[jid];
        } else if (isGroup && documentoPendente && documentoPendente.solicitante === sender) {
            const respostaDocumento = body.trim().toLocaleLowerCase('pt-BR');
            if (/^(sim|s|✅)$/.test(respostaDocumento)) {
                delete documentosPendentes[jid];
                try {
                    await sock.sendMessage(jid, { text: '⏳ Preparando e enviando o documento diário...' });
                    await sock.sendMessage(jid, {
                        document: Buffer.from(documentoPendente.conteudo, 'utf8'),
                        mimetype: 'text/plain',
                        fileName: `relatorio-diario-${documentoPendente.data}.txt`,
                        caption: `📄 Relatório diário de ${documentoPendente.data.split('-').reverse().join('/')}`
                    });
                } catch (erroDocumento) {
                    console.error('[documento] falha ao enviar o relatório:', erroDocumento.message);
                    await sock.sendMessage(jid, { text: '❌ Não consegui enviar o documento. Verifique a conexão do bot e tente novamente com *.documento*.' });
                }
                return;
            }
            if (/^(não|nao|n|❌)$/.test(respostaDocumento)) {
                delete documentosPendentes[jid];
                await sock.sendMessage(jid, { text: '✅ Geração do documento cancelada.' });
                return;
            }
        }
        const botJid = jidNormalizedUser(sock.user?.id ||  '');
        const botMencionado = contextoMensagem.mentionedJid?.includes(botJid);
        const botCitado = contextoMensagem.participant === botJid;
        const mensagemImportante = /\b(urgente|importante|ajuda|problema|dúvida|duvida|aviso|atenção|atencao|socorro)\b/i.test(body);

        if (!isGroup && fluxosAluguel[sender]?.etapa === 'email' && body.trim() && !body.trim().startsWith('.')) {
            const email = body.trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                await sock.sendMessage(sender, { text: '❌ E-mail inválido. Digite um e-mail válido para gerar o Pix.' });
                return;
            }
            await criarPagamentoAluguel(sock, sender, email);
            return;
        }

        if (isGroup && (botMencionado || botCitado || mensagemImportante)) {
            await responderComIA(sock, jid, body, sender);
        }

        if (!isGroup && !m.message.conversation && !m.message.extendedTextMessage?.text) {
            const sessao = sessoesTriagem[sender];
            if (sessao) {
                const media = await baixarMidiaDoMensagem(sock, m.message);
                if (media) adicionarMidiaTriagem(sessao, media.tipo, media.buffer);
            }
        }

        if (!isGroup) {
            const sessao = sessoesTriagem[sender];
            const txt = m.message.conversation || m.message.extendedTextMessage?.text || '';

            // Triagem: captura número
            if (sessao && txt && !txt.startsWith('.')) {
                const matchNumero = txt.match(/[\d\s\-\+\(\)]{7,}/);
                if (matchNumero) sessao.numeroInformado = matchNumero[0].replace(/[\s\-]/g, '').trim();
            }

            // === CADASTRO DE PERFIL PASSO A PASSO ===
            if (perfilEmRegistro[sender] && txt && !txt.startsWith('.')) {
                const reg = perfilEmRegistro[sender];
                if (reg.etapa === 'nome') {
                    reg.dados.nome = txt.trim();
                    reg.etapa = 'idade';
                    await sock.sendMessage(jid, { text: '✅ Nome salvo!\n\n(2/5) Digite sua *IDADE*:' });
                } else if (reg.etapa === 'idade') {
                    reg.dados.idade = txt.trim();
                    reg.etapa = 'sexualidade';
                    await sock.sendMessage(jid, { text: '✅ Idade salva!\n\n(3/5) Digite sua *SEXUALIDADE*:' });
                } else if (reg.etapa === 'sexualidade') {
                    reg.dados.sexualidade = txt.trim();
                    reg.etapa = 'hobbies';
                    await sock.sendMessage(jid, { text: '✅ Sexualidade salva!\n\n(4/5) Digite seus *HOBBIES*:' });
                } else if (reg.etapa === 'hobbies') {
                    reg.dados.hobbies = txt.trim();
                    reg.etapa = 'estadoCivil';
                    await sock.sendMessage(jid, { text: '✅ Hobbies salvos!\n\n(5/5) Digite seu *ESTADO CIVIL*:' });
                } else if (reg.etapa === 'estadoCivil') {
                    reg.dados.estadoCivil = txt.trim();
                    reg.etapa = 'finalizar';
                    await sock.sendMessage(jid, { text: `✅ Tudo preenchido!\n\n👤 Nome: ${reg.dados.nome}\n🎂 Idade: ${reg.dados.idade}\n🏳️‍🌈 Sexualidade: ${reg.dados.sexualidade}\n🎮 Hobbies: ${reg.dados.hobbies}\n💍 Estado civil: ${reg.dados.estadoCivil}\n\nEnvie *.pronto* para salvar!` });
                }
                return; // ← IMPORTANTE: para não continuar processando
            }
        }

        const agoraMs = Date.now();
        if (ultimaInteracao[sender] && (agoraMs - ultimaInteracao[sender]) > 5 * 24 * 60 * 60 * 1000) {
            saldosUFSC[sender] = 0;
        }
        ultimaInteracao[sender] = agoraMs;

        interacaoPerfil[sender] = (interacaoPerfil[sender] || 0) + 1;

        if (isGroup) {
            ultimaMsgGrupo[sender] = agoraMs;

            if (!mensagensRastreadas[jid]) mensagensRastreadas[jid] = {};
            if (!mensagensRastreadas[jid][sender]) mensagensRastreadas[jid][sender] = [];
            mensagensRastreadas[jid][sender].push({ key: m.key, time: agoraMs });
            if (mensagensRastreadas[jid][sender].length > LIMITE_RASTRO) {
                mensagensRastreadas[jid][sender].shift();
            }
        }

        if (isGroup && floodAtivo[jid]) {
            let mediaHash = null;
            let tipoMidia = '';
            if (m.message.stickerMessage) {
                mediaHash = m.message.stickerMessage.fileSha256?.toString('base64') || m.message.stickerMessage.url || m.message.stickerMessage.fileLength;
                tipoMidia = 'figurinha';
            } else if (m.message.imageMessage) {
                mediaHash = m.message.imageMessage.fileSha256?.toString('base64') || m.message.imageMessage.url || m.message.imageMessage.fileLength;
                tipoMidia = 'foto';
            }

            if (mediaHash) {
                let senderEhAdminFlood = (sender === DONO_SUPREMO || sender === DONO_ADMIN);
                if (!senderEhAdminFlood) {
                    try {
                        const metaFlood = await sock.groupMetadata(jid);
                        senderEhAdminFlood = metaFlood.participants.filter(p => p.admin).map(p => p.id).includes(sender);
                    } catch {}
                }

                if (!senderEhAdminFlood) {
                    const keyFlood = jid + '|' + sender + '|' + mediaHash;
                    if (!floodContagem[keyFlood]) {
                        floodContagem[keyFlood] = { count: 0, firstTime: agoraMs };
                    }
                    if (agoraMs - floodContagem[keyFlood].firstTime > FLOOD_JANELA) {
                        floodContagem[keyFlood] = { count: 0, firstTime: agoraMs };
                    }
                    floodContagem[keyFlood].count++;

                    if (floodContagem[keyFlood].count > FLOOD_LIMITE) {
                        try {
                            await sock.sendMessage(jid, {
                                text: `🚫 *ANTI-FLOOD!*\n\n@${sender.split('@')[0]} enviou a mesma ${tipoMidia} ${floodContagem[keyFlood].count}x.\n➥ Removido do grupo!`,
                                mentions: [sender]
                            });
                            await sock.groupParticipantsUpdate(jid, [sender], 'remove');
                        } catch (err) {
                            console.error('[flood] erro ao remover:', err.message);
                        }
                        delete floodContagem[keyFlood];
                        return;
                    }
                }
            }
        }

        if (!isGroup && body.startsWith('.')) {
            const pvArgs    = body.slice(1).trim().split(/ +/);
            const pvCommand = pvArgs.shift().toLowerCase();

            if (pvCommand === 'pix') {
                const fluxo = fluxosAluguel[sender];
                if (!fluxo || fluxo.expiraEm < Date.now()) {
                    delete fluxosAluguel[sender];
                    return sock.sendMessage(jid, { text: '⚠️ Não encontrei um pedido de aluguel ativo. Envie *.alugar* no grupo que deseja liberar.' });
                }
                fluxo.etapa = 'email';
                return sock.sendMessage(jid, { text: '📧 Digite seu e-mail para gerar o Pix do Mercado Pago. O pedido expira em 30 minutos.' });
            }

            if (pvCommand === 'registrar') {
                if (perfis[sender]) return sock.sendMessage(jid, { text: '❌ Você já tem perfil. Use *.editar* para alterar.' });
                perfilEmRegistro[sender] = { etapa: 'nome', dados: {} };
                return sock.sendMessage(jid, { text: '📝 *CADASTRO DE PERFIL*\n\n(1/5) Digite seu *NOME*:' });
            }

            if (pvCommand === 'pronto') {
                const reg = perfilEmRegistro[sender];
                if (!reg || reg.etapa !== 'finalizar') return sock.sendMessage(jid, { text: '❌ Preenchimento incompleto. Use *.registrar* para começar.' });
                perfis[sender] = reg.dados;
                delete perfilEmRegistro[sender];
                return sock.sendMessage(jid, { text: '✅ *PERFIL SALVO!*\n\nUse *.perfil* no grupo para exibir.' });
            }

            if (pvCommand === 'editar') {
                if (!perfis[sender]) return sock.sendMessage(jid, { text: '❌ Sem perfil ainda. Use *.registrar* primeiro.' });
                const mapaCampos = { nome: 'nome', idade: 'idade', sexualidade: 'sexualidade', hobbies: 'hobbies', civil: 'estadoCivil', estadocivil: 'estadoCivil' };
                const campo = pvArgs[0]?.toLowerCase();
                const valor = pvArgs.slice(1).join(' ').trim();
                if (!campo) {
                    const p = perfis[sender];
                    return sock.sendMessage(jid, { text: `✏️ *EDITAR PERFIL*\n\n👤 Nome: ${p.nome}\n🎂 Idade: ${p.idade}\n🏳️‍🌈 Sexualidade: ${p.sexualidade}\n🎮 Hobbies: ${p.hobbies}\n💍 Estado civil: ${p.estadoCivil}\n\nUse:\n*.editar nome <novo>*\n*.editar idade <novo>*\n*.editar sexualidade <novo>*\n*.editar hobbies <novo>*\n*.editar civil <novo>*` });
                }
                const campoReal = mapaCampos[campo];
                if (!campoReal) return sock.sendMessage(jid, { text: '❌ Campo inválido. Use: nome, idade, sexualidade, hobbies, civil' });
                if (!valor) return sock.sendMessage(jid, { text: `❌ Informe o valor. Ex: *.editar ${campo} novovalor*` });
                perfis[sender][campoReal] = valor;
                return sock.sendMessage(jid, { text: `✅ *${campo}* atualizado: ${valor}` });
            }

            try {
        const codigoTriagem = /^triagem(\d+)$/.exec(pvCommand)?.[1]
            || (pvCommand === 'triagem' && /^\d+$/.test(pvArgs[0] || '') ? pvArgs[0] : null);
        if (pvCommand === 'triagem' || codigoTriagem) {
            const grupoDestino = codigoTriagem ? gruposTriagemPorCodigo[codigoTriagem] : grupoTriagemAtivo;
            const estado = codigoTriagem ? obterEstadoTriagem(grupoDestino) : null;
            if (!grupoDestino || (codigoTriagem && !estado?.ativa)) {
                return sock.sendMessage(jid, { text: codigoTriagem ? `⚠️ Não há triagem ativa para o código ${codigoTriagem}.` : '⚠️ Nenhum grupo ativou a triagem no momento.' });
            }
            if (sessoesTriagem[sender] && sessoesTriagem[sender].grupoJid !== grupoDestino) {
                return sock.sendMessage(jid, { text: '⚠️ Você já tem uma triagem aberta para outro grupo. Finalize-a antes de iniciar outra.' });
            }
            const finalizadas = estado ? estado.finalizadas : triagensFinalizadas;
            if (finalizadas.has(sender)) return sock.sendMessage(jid, { text: '❌ Você já realizou sua triagem neste grupo.' });

            if (!sessoesTriagem[sender]) {
                const sessao = criarSessaoTriagem(sender, grupoDestino);
                sessao._codigoTriagem = codigoTriagem;
                sessoesTriagem[sender] = sessao;
                try { analiseDiaria.registrarEvento('triagemIniciada', grupoDestino); }
                catch (erroRegistro) { console.error('[documento] falha ao salvar início de triagem:', erroRegistro.message); }
                sessao._expiracao = setTimeout(async () => {
                    if (sessoesTriagem[sender] === sessao) {
                        delete sessoesTriagem[sender];
                        finalizadas.delete(sender);
                        try { await sock.sendMessage(sender, { text: `⏰ Sua triagem expirou. Inicie novamente com *.triagem${codigoTriagem || ''}*.` }); } catch {}
                        try { await sock.sendMessage(grupoDestino, { text: `⏰ Triagem de *${sender.split('@')[0]}* expirou por inatividade.` }); } catch {}
                    }
                }, 2 * 60 * 1000);
            }

            const responsavel = estado ? estado.responsavel : sessaoTriagemResponsavel;
            const responsavelApelido = responsavel && adminsTriagem[responsavel] ? adminsTriagem[responsavel].apelido : 'Equipe';
            return sock.sendMessage(jid, {
                text: `Para fazer sua triagem:\n\n1️⃣ Informe seu número de celular\n2️⃣ Mande os prints com as contas de email\n3️⃣ Mande 2 áudios ou 1 áudio dos personagens\n4️⃣ Quando terminar, diga *.finalizar*\n\n👔 Responsável pela triagem: *${responsavelApelido}*`
            });
        }

        if (pvCommand === 'finalizar') {
            const sessao = sessoesTriagem[sender];
            if (!sessao) return sock.sendMessage(jid, { text: '⚠️ Você ainda não iniciou uma triagem. Envie *.triagem<CÓDIGO>* primeiro.' });
            const estado = sessao._codigoTriagem ? obterEstadoTriagem(sessao.grupoJid) : null;
            if (estado ? !estado.ativa : !grupoTriagemAtivo) {
                delete sessoesTriagem[sender];
                return sock.sendMessage(jid, { text: '⚠️ O grupo desta triagem não está recebendo triagens no momento.' });
            }
            if (sessao._expiracao) clearTimeout(sessao._expiracao);
            const numeroExibir = sessao.numeroInformado || sender.split('@')[0];
            delete sessoesTriagem[sender];
            const fila = estado ? estado.filaPendente : filaPendente;
            const finalizadas = estado ? estado.finalizadas : triagensFinalizadas;
            finalizadas.add(sender);
            const ticket = estado ? ++estado.contadorTicket : ++contadorTicket;
            fila.push({ ticket, senderJid: sender, numeroExibir, sessao });
            try { analiseDiaria.registrarEvento('triagemEnviada', sessao.grupoJid); }
            catch (erroRegistro) { console.error('[documento] falha ao salvar triagem enviada:', erroRegistro.message); }
            const emAnalise = estado ? estado.filaEmAnalise : filaEmAnalise;
            const posicaoFila = fila.length + (emAnalise ? 1 : 0);
            await sock.sendMessage(sender, {
                text: `✅ Triagem enviada!\n\n🎫 *Ticket: #${ticket}*\n📊 Posição na fila: *${posicaoFila}º*\n\n⏳ Você será notificado(a) assim que sua triagem for analisada.`
            });
            if (!emAnalise) await enviarProximaTriagemAoGrupo(sock, estado);
            return;
        }

        // ============================================================
        // .apontar <nome> — jogada do Cidade Dorme no PV
        // ============================================================
        if (pvCommand === 'apontar') {
            if (!jogoCidade.emAndamento || !jogoCidade.aguardando) {
                return sock.sendMessage(jid, { text: '❌ Nenhum jogo ativo aguardando sua resposta.' });
            }
            const nomeAlvo = pvArgs.join(' ').toLowerCase().trim();
            if (!nomeAlvo) return sock.sendMessage(jid, { text: '❌ Use: *.apontar <nome>*' });

            console.log('[apontar PV] sender:', sender, '| aguardando:', jogoCidade.aguardando, '| alvo:', nomeAlvo);

            // === VEZ DO XERIFE ===
            if (jogoCidade.aguardando === 'sheriff' && sender === jogoCidade.xerife) {
                const alvo = jogoCidade.jogadores.find(j => j.nome.toLowerCase() === nomeAlvo);
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Jogador não encontrado. Verifique o nome e tente novamente.' });

                if (alvo.jid === jogoCidade.assassino) {
                    await sock.sendMessage(jid, { text: `🎉 *VOCÊ ACERTOU!*\n\n🕵️ ${alvo.nome} era o assassino!\n✅ Os inocentes vencem!` });
                    jogoCidade.jogadores = jogoCidade.jogadores.filter(j => j.jid !== jogoCidade.assassino);
                    return fimDeJogo(sock, jogoCidade, `🕵️ *O XERIFE DESCOBRIU O ASSASSINO!*\n\n🔫 ${alvo.nome} era o assassino!\n✅ *OS INOCENTES VENCERAM!* 🎉`);
                }

                const nomeXerifeAntigo = jogoCidade.jogadores.find(j => j.jid === jogoCidade.xerife)?.nome || 'Xerife';
                jogoCidade.jogadores = jogoCidade.jogadores.filter(j => j.jid !== alvo.jid && j.jid !== jogoCidade.xerife);
                const restantes = jogoCidade.jogadores.filter(j => j.jid !== jogoCidade.assassino);

                if (restantes.length === 0) {
                    await sock.sendMessage(jid, { text: `☠️ *VOCÊ ERROU!*\n\n${alvo.nome} era inocente...\nO assassino venceu!` });
                    return fimDeJogo(sock, jogoCidade, `❌ *O XERIFE ERROU!*\n\n💀 ${alvo.nome} era inocente\n💀 ${nomeXerifeAntigo} (xerife) foi eliminado\n🔪 *O ASSASSINO VENCEU!*`);
                }

                jogoCidade.xerife = restantes[Math.floor(Math.random() * restantes.length)].jid;
                const nomeNovoXerife = jogoCidade.jogadores.find(j => j.jid === jogoCidade.xerife).nome;
                await sock.sendMessage(jogoCidade.xerife, { text: '⭐ *VOCÊ É O NOVO XERIFE!*\n\nVocê será questionado em breve...' });
                await sock.sendMessage(jid, { text: `❌ *VOCÊ ERROU!*\n\n${alvo.nome} era inocente.\nVocê foi eliminado, mas um novo xerife foi escolhido.` });
                await notificarGrupo(sock, jogoCidade, `🔫 *O XERIFE ERROU!*\n\n💀 ${alvo.nome} (inocente) foi eliminado\n💀 ${nomeXerifeAntigo} (xerife) foi eliminado\n⭐ Novo xerife: *${nomeNovoXerife}*\n👥 Restam: ${jogoCidade.jogadores.length} jogadores`);

                return pedirAssassino(sock, jogoCidade);
            }

            // === VEZ DO ASSASSINO ===
            if (jogoCidade.aguardando === 'assassino' && sender === jogoCidade.assassino) {
                const alvo = jogoCidade.jogadores.find(j => j.nome.toLowerCase() === nomeAlvo);
                if (!alvo || alvo.jid === jogoCidade.assassino) return sock.sendMessage(jid, { text: '❌ Alvo inválido. Escolha outro jogador.' });

                jogoCidade.jogadores = jogoCidade.jogadores.filter(j => j.jid !== alvo.jid);

                if (jogoCidade.jogadores.length <= 1) {
                    await sock.sendMessage(jid, { text: `🎉 *VOCÊ ELIMINOU TODOS!*\n\n💀 ${alvo.nome} foi eliminado.\n🏆 Você venceu o jogo!` });
                    return fimDeJogo(sock, jogoCidade, `🔪 *O ASSASSINO VENCEU!*\n\n💀 ${alvo.nome} foi eliminado\n🏆 *O assassino sobreviveu e venceu o jogo!*`);
                }

                await sock.sendMessage(jid, { text: `✅ *ALVO ELIMINADO!*\n\n💀 ${alvo.nome} foi eliminado.\n👥 Restam ${jogoCidade.jogadores.length} jogadores.` });
                await notificarGrupo(sock, jogoCidade, `🔪 *O ASSASSINO AGIU!*\n\n💀 ${alvo.nome} foi eliminado\n👥 Restam: ${jogoCidade.jogadores.length} jogadores`);

                return pedirXerife(sock, jogoCidade);
            }

            return sock.sendMessage(jid, { text: '❌ Não é sua vez de jogar agora.' });
        }
    } catch (cmdErr) {
        console.error(`[PV] .${pvCommand}:`, cmdErr);
        try { await sock.sendMessage(jid, { text: `❌ Erro interno: ${cmdErr.message}` }); } catch {}
    }
    return;
}

if (isGroup && unoGame.emAndamento && m.message.stickerMessage) {
            const hash = m.message.stickerMessage.fileSha256?.toString('base64');
            if (hash && unoGame.cartasPorHash[hash]) {
                await processarJogadaUno(sock, sender, hash, jid);
                return;
            }
        }
        
        if (!isGroup) return;

        if (anagramaGame.ativo && anagramaGame.jid === jid && body.toLowerCase() === anagramaGame.palavra) {
            saldosUFSC[sender] = (saldosUFSC[sender] || 0) + 1;
            await sock.sendMessage(jid, { text: `🎉 *ACERTOU!* @${sender.split('@')[0]} ganhou 1 UFSC! 💰 Saldo: ${saldosUFSC[sender]}`, mentions: [sender] });
            const novo = gerarAnagrama();
            anagramaGame.palavra = novo.original; anagramaGame.embaralhada = novo.embaralhada;
            return sock.sendMessage(jid, { text: `🧩 *${anagramaGame.embaralhada}*` });
        }

        const chaveMuteTemporario = `${jid}|${sender}`;
        const muteTemporario = isGroup ? mutesTemporarios[chaveMuteTemporario] : null;
        if (muteTemporario) {
            if (Date.now() >= muteTemporario.expiraEm) {
                clearTimeout(muteTemporario.timer);
                delete mutesTemporarios[chaveMuteTemporario];
                await sock.sendMessage(jid, {
                    text: `🔊 @${sender.split('@')[0]} já pode voltar a falar.`,
                    mentions: [sender]
                });
            } else {
                try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
                return;
            }
        }

        if (mutados.includes(sender)) {
            try {
                await sock.sendMessage(jid, { delete: m.key });
                advertencias[sender] = (advertencias[sender] || 0) + 1;
                if (advertencias[sender] >= 3) {
                    await sock.sendMessage(jid, { text: `🚫 @${sender.split('@')[0]} atingiu 3/3. Removido.`, mentions: [sender] });
                    await sock.groupParticipantsUpdate(jid, [sender], 'remove');
                    mutados = mutados.filter(x => x !== sender); delete advertencias[sender];
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]} silenciado! Adv: ${advertencias[sender]}/3`, mentions: [sender] });
                }
            } catch {}
            return;
        }

        let isSenderAdmin = (sender === DONO_SUPREMO || sender === DONO_ADMIN);
        if (!isSenderAdmin) {
            try {
                const meta = await sock.groupMetadata(jid);
                isSenderAdmin = meta.participants.filter(p => p.admin).map(p => p.id).includes(sender);
            } catch {}
        }

        const mensagemEhComando = body.startsWith('.') || body.startsWith('cmd_');
        if (isGroup && apenasAdmAtivo[jid] && mensagemEhComando && !isSenderAdmin &&
            !/^\.ocorrencia(?:\s|$)/i.test(body.trim())) {
            await sock.sendMessage(jid, { text: '⛔ Apenas administradores podem usar os comandos do bot neste grupo.' }, { quoted: m });
            return;
        }

        if (body.includes('@name') && isSenderAdmin) {
            const meta = await sock.groupMetadata(jid);
            await sock.sendMessage(jid, { text: `📢 *Chamada Geral!*`, mentions: meta.participants.map(p => p.id) });
        }

        if (adminsTriagem[sender]?._aguardandoEscolha && /^[1-6]$/.test(body.trim())) {
            const dadosAdm = adminsTriagem[sender];
            const idx = parseInt(body.trim()) - 1;
            if (dadosAdm._slotsDisponiveis?.[idx]) {
                dadosAdm.horarioMarcado = dadosAdm._slotsDisponiveis[idx];
                dadosAdm._aguardandoEscolha = false;
                delete dadosAdm._slotsDisponiveis;
                const estado = estadosTriagem[dadosAdm._grupoTriagemJid];
                if (estado) estado.responsavel = sender;
                else sessaoTriagemResponsavel = sender;
                await sock.sendMessage(jid, {
                    text: `✅ *Plantão marcado!*\n\n👔 *${dadosAdm.apelido}* está de plantão agora\n🕐 Horário marcado: *${dadosAdm.horarioMarcado}*\n\nApenas você pode aprovar/reprovar as triagens desta sessão.`,
                    mentions: [sender]
                });
            }
            return;
        }

        if (!body.startsWith('.') && !body.startsWith('cmd_')) return;

        const args    = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        const comandosTriagemGrupo = new Set([
            'registrar_grupo_triagem', 'ativar_triagem', 'desativar_triagem',
            'ativar_fila', 'desativar_fila', 'registrar_link', 'registrar_adm',
            'login_triagem', 'aprovar', 'reprovar', 'metas', 'alterar_meta', 'menu3'
        ]);
        const grupoTriagemCadastrado = Object.values(gruposTriagemPorCodigo).includes(jid);
        const sorteioAtivoNoGrupo = sorteiosAtivosPorGrupo[jid] === true;
        const comandosSorteio = new Set(['ranking', 'mutar', 'roubar']);
        const comandosOcorrencia = new Set(['localocorrencias', 'registrarocorrencia', 'desregistrarocorrencia', 'ocorrencia']);
        if (!gruposRegistrados.includes(jid) && command !== 'registrar' && command !== 'bot_sorteia' &&
            command !== 'alugar' && command !== 'pix' &&
            command !== 'documento' &&
            !comandosOcorrencia.has(command) &&
            !(grupoTriagemCadastrado && comandosTriagemGrupo.has(command)) &&
            !(sorteioAtivoNoGrupo && comandosSorteio.has(command))) return;

        const agoraCmd  = new Date();
        const horarioCmd = agoraCmd.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const dataCmd    = agoraCmd.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const logComando = `\n\n*CMD:* @${sender.split('@')[0]} : ${horarioCmd} : ${dataCmd}`;

        historicoComandos.push({ comando: command, usuario: sender, horario: horarioCmd, data: dataCmd });
        if (historicoComandos.length > 50) historicoComandos.shift();

        const agora = Date.now();
        const comandoAluguel = command === 'alugar' || command === 'pix';
        if (!comandoAluguel && cooldowns[sender] && agora < cooldowns[sender] + 10000) {
            const r = ((cooldowns[sender] + 10000 - agora) / 1000).toFixed(1);
            return sock.sendMessage(jid, { text: `⏳ Aguarde ${r}s.` }, { quoted: m });
        }
        if (!comandoAluguel) cooldowns[sender] = agora;

        if (command.startsWith('mudapreço_fig_')) {
            if (!isSenderAdmin) return;
            const novoPreco = parseInt(command.split('_').pop());
            if (isNaN(novoPreco)) return sock.sendMessage(jid, { text: '❌ Valor inválido.' });
            precoFigurinha = novoPreco;
            return sock.sendMessage(jid, { text: `✅ Preço figurinha: *${precoFigurinha} UFSC*` });
        }

        let mentions  = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const getMention = () => mentions[0] || m.message.extendedTextMessage?.contextInfo?.participant;

        if (isGroup && body.startsWith('cmd_')) {
            const instrucoesComandos = {
                eliminar: 'Use *.eliminar @pessoa* para abrir uma votação.',
                votar: 'Use *.votar @pessoa* durante uma votação.',
                encerrarvotos: 'Use *.encerrarvotos* para finalizar a votação.',
                criarsorteio: 'Use *.criarsorteio <prêmio>* para criar um sorteio.',
                entrarsorteio: 'Use *.entrarsorteio* para participar.',
                sorteaagora: 'Use *.sorteaagora* para sortear o vencedor.',
                logobot: 'Responda uma imagem com *.logobot* para registrá-la como logo.',
                ocorrencia: 'Responda à mensagem com *.ocorrencia* ou envie uma foto com a legenda *.ocorrencia*; o registro será encaminhado ao grupo destinatário configurado.',
                uno: 'Use *.uno* para abrir uma partida de UNO.',
                cidadedorme: 'Use *.cidadedorme* para abrir Cidade Dorme.',
                triagem: 'Use *.registrar_grupo_triagem <código>* no grupo destino; no privado use *.triagem<código>*.',
                flood: 'Use *.flood* para ativar ou desativar o anti-flood.',
                ranking: 'Use *.ranking* para consultar o ranking do grupo.',
                roubar: 'Use *.roubar @pessoa* para tentar roubar 1 ponto; a chance de sucesso é 50%.',
                relatorio: 'Use *.relatorio* para consultar o relatório de comandos.',
                meme: 'Use *.meme <tema>* para buscar um meme relacionado ou *.meme* para um meme aleatório.',
                play: 'Use *.play <nome da música>* para tocar uma música.',
                brat: 'Use *.brat <texto>* para criar uma figurinha.',
                perfil: 'No privado, use *.registrar* para criar seu perfil; no grupo, use *.perfil*.',
                documento: 'Use *.documento* neste grupo (administradores) para gerar o relatório diário agregado de todos os grupos.',
                comandos: 'Use *.menu* para abrir novamente esta lista.'
            };
            const comandoSelecionado = body.slice(4);
            return sock.sendMessage(jid, {
                text: instrucoesComandos[comandoSelecionado] || '⚠️ Opção de comando não reconhecida.'
            }, { quoted: m });
        }

        if (sender === DONO_SUPREMO && command === 'off') { botSilenciado = true; return sock.sendMessage(jid, { text: '🔇 Bot OFF.' }); }
        if (sender === DONO_SUPREMO && command === 'on')  { botSilenciado = false; return sock.sendMessage(jid, { text: '🔊 Bot ON.' }); }
        if (botSilenciado) return;

        switch (command) {
            case 'alugar': {
                if (!isGroup) {
                    return sock.sendMessage(jid, { text: '❌ Envie *.alugar* no grupo que deseja liberar.' }, { quoted: m });
                }
                if (!isSenderAdmin) {
                    return sock.sendMessage(jid, { text: '❌ Somente um administrador do grupo pode iniciar o aluguel.' }, { quoted: m });
                }
                if (gruposRegistrados.includes(jid) && !alugueisAtivosPorGrupo[jid]) {
                    return sock.sendMessage(jid, { text: '✅ Este grupo já está liberado para usar o bot.' }, { quoted: m });
                }
                fluxosAluguel[sender] = {
                    grupoJid: jid,
                    etapa: 'email',
                    expiraEm: Date.now() + 30 * 60 * 1000
                };
                return sock.sendMessage(jid, {
                    text: `🛒 *Aluguel do bot*\n\n💰 R$ ${PRECO_ALUGUEL_MENSAL.toFixed(2).replace('.', ',')} por 30 dias\n💳 Forma de pagamento disponível: *Pix*\n\nPara continuar com segurança, abra o privado do bot e envie *.pix*.`
                }, { quoted: m });
            }

            case 'pix': {
                if (isGroup) {
                    return sock.sendMessage(jid, { text: '🔒 Para gerar o Pix, envie *.pix* no privado do bot.' }, { quoted: m });
                }
                const fluxo = fluxosAluguel[sender];
                if (!fluxo || fluxo.expiraEm < Date.now()) {
                    delete fluxosAluguel[sender];
                    return sock.sendMessage(jid, { text: '⚠️ Não encontrei um pedido de aluguel ativo. Envie *.alugar* no grupo que deseja liberar.' }, { quoted: m });
                }
                fluxo.etapa = 'email';
                return sock.sendMessage(jid, { text: '📧 Digite seu e-mail para gerar o Pix do Mercado Pago. O pedido expira em 30 minutos.' }, { quoted: m });
            }

            case 'voz': {
                const textoVoz = args.join(' ').trim();
                if (!textoVoz) return sock.sendMessage(jid, { text: '❌ Escreva o texto. Exemplo: *.voz Olá, pessoal!*' }, { quoted: m });
                if (textoVoz.length > 200) return sock.sendMessage(jid, { text: '⚠️ O texto pode ter no máximo 200 caracteres.' }, { quoted: m });

                await sock.sendMessage(jid, { text: '🎙️ *Gravando...*' }, { quoted: m });
                try {
                    const audioGoogle = await gerarAudioGoogle(textoVoz);
                    const audioVoz = await converterParaOpus(audioGoogle);
                    await sock.sendMessage(jid, {
                        audio: audioVoz,
                        mimetype: 'audio/ogg; codecs=opus',
                        ptt: true
                    }, { quoted: m });
                } catch (errVoz) {
                    console.error('[voz] erro:', errVoz.response?.data?.error?.message || errVoz.message);
                    await sock.sendMessage(jid, { text: '❌ Houve um erro ao gerar o áudio do Google.' }, { quoted: m });
                }
                break;
            }

            case 'documento': {
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Use *.documento* dentro do grupo onde deseja receber o relatório.' }, { quoted: m });
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas administradores podem gerar o relatório diário.' }, { quoted: m });
                await sock.sendMessage(jid, { text: '🔎 Analisando os comandos, ocorrências, solicitações e triagens de hoje em todos os grupos...' }, { quoted: m });

                try {
                    const chaveData = dataHojeSaoPaulo();
                    const relatorio = analiseDiaria.obterRelatorio(chaveData);
                    const triagensPendentes = {};
                    for (const [grupoTriagem, estado] of Object.entries(estadosTriagem)) {
                        const quantidade = estado.filaPendente.length + (estado.filaEmAnalise ? 1 : 0);
                        if (quantidade) triagensPendentes[grupoTriagem] = quantidade;
                    }
                    if (filaPendente.length || filaEmAnalise) {
                        const grupo = grupoTriagemAtivo || 'privado';
                        triagensPendentes[grupo] = (triagensPendentes[grupo] || 0) + filaPendente.length + (filaEmAnalise ? 1 : 0);
                    }

                    const mensagens = analiseDiaria.obterMensagens(chaveData);
                    const gruposRelatorio = new Set([
                        ...Object.keys(relatorio.grupos || {}),
                        ...Object.keys(triagensPendentes),
                        ...mensagens.map((mensagem) => mensagem.conversa)
                    ]);
                    const nomesGrupos = {};
                    await Promise.all([...gruposRelatorio].filter(grupo => grupo.endsWith('@g.us')).map(async (grupo) => {
                        try {
                            const metadados = await sock.groupMetadata(grupo);
                            nomesGrupos[grupo] = metadados.subject || grupo;
                        } catch (erroMetadados) {
                            console.warn(`[documento] não foi possível obter o nome do grupo ${grupo}:`, erroMetadados.message);
                        }
                    }));

                    const solicitacoesAguardando = Object.keys(solicitacoesPendentes).length;
                    const conteudo = formatarDocumentoDiario(chaveData, relatorio, nomesGrupos, triagensPendentes, mensagens, solicitacoesAguardando);
                    documentosPendentes[jid] = {
                        solicitante: sender,
                        expiraEm: Date.now() + 5 * 60 * 1000,
                        data: chaveData,
                        conteudo
                    };
                    const triagensEnviadas = relatorio.eventos.triagemEnviada || 0;
                    const ocorrencias = relatorio.eventos.ocorrencia || 0;
                    const aprovadas = relatorio.eventos.triagemAprovada || 0;
                    const reprovadas = relatorio.eventos.triagemReprovada || 0;
                    await sock.sendMessage(jid, {
                        text: `📊 *ANÁLISE DIÁRIA CONCLUÍDA — ${chaveData.split('-').reverse().join('/')}*\n\n🔹 Comandos utilizados: *${relatorio.totalComandos || 0}*\n🔹 Ocorrências/denúncias registradas: *${ocorrencias}*\n🔹 Triagens enviadas: *${triagensEnviadas}*\n🔹 Triagens aprovadas/reprovadas: *${aprovadas}/${reprovadas}*\n🔹 Triagens aguardando análise agora: *${Object.values(triagensPendentes).reduce((soma, quantidade) => soma + quantidade, 0)}*\n🔹 Solicitações aprovadas/recusadas: *${relatorio.eventos.solicitacaoAprovada || 0}/${relatorio.eventos.solicitacaoRejeitada || 0}*\n🔹 Solicitações aguardando decisão: *${solicitacoesAguardando}*\n🔹 Mensagens no histórico do dia: *${mensagens.length}*\n\nO arquivo inclui o histórico textual de mensagens recebidas e enviadas. Fotos, áudios, vídeos e documentos aparecem identificados pelo tipo, mas os arquivos não são armazenados.\n\nDeseja receber o documento neste grupo? Responda *sim* ou *não* em até 5 minutos.`
                    }, { quoted: m });
                } catch (erroDocumento) {
                    delete documentosPendentes[jid];
                    console.error('[documento] falha ao gerar o relatório diário:', erroDocumento.message);
                    await sock.sendMessage(jid, { text: '❌ Não consegui analisar os dados diários. Confira o arquivo documento_estatisticas.json e as permissões de gravação do bot.' }, { quoted: m });
                }
                break;
            }

            case 'anunciar_link': {
                if (!isSenderAdmin) return;
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: m });
                const linkAnuncio = args[0]?.trim();
                const horarioAnuncio = args[1]?.trim();
                const textoAnuncio = args.slice(2).join(' ').trim();
                if (!linkAnuncio || !horarioAnuncio || !textoAnuncio) {
                    return sock.sendMessage(jid, { text: '❌ Uso: *.anunciar_link <link> <horário> <texto>*\nExemplo: *.anunciar_link https://meet.google.com/abc 20:00 Reunião da equipe*' }, { quoted: m });
                }
                try { new URL(linkAnuncio); } catch {
                    return sock.sendMessage(jid, { text: '❌ Informe um link válido, começando com http:// ou https://.' }, { quoted: m });
                }
                if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horarioAnuncio)) {
                    return sock.sendMessage(jid, { text: '❌ O horário deve estar no formato HH:MM. Exemplo: 20:00.' }, { quoted: m });
                }
                const agoraAnuncio = Date.now();
                anunciosLinks = anunciosLinks.filter((anuncio) => agoraAnuncio - anuncio.criadoEm < 24 * 60 * 60 * 1000);
                if (anunciosLinks.some((anuncio) => anuncio.link === linkAnuncio)) {
                    return sock.sendMessage(jid, { text: '⚠️ Esse link já está registrado e ainda está válido.' }, { quoted: m });
                }
                anunciosLinks.push({ link: linkAnuncio, horario: horarioAnuncio, texto: textoAnuncio, criadoEm: agoraAnuncio, anunciadoEm: {} });
                salvarAnunciosLinks();
                return sock.sendMessage(jid, { text: `✅ Link registrado por 24 horas.\n\n🕒 Horário: *${horarioAnuncio}*\n📝 Texto: *${textoAnuncio}*\n\nUse *.anunciar* no grupo de destino para publicar.` }, { quoted: m });
            }

            case 'anunciar': {
                if (!isGroup) return;
                const agoraAnuncio = Date.now();
                anunciosLinks = anunciosLinks.filter((anuncio) => agoraAnuncio - anuncio.criadoEm < 24 * 60 * 60 * 1000);
                const pendentesAnuncio = anunciosLinks.filter((anuncio) => !anuncio.anunciadoEm?.[jid]);
                if (!pendentesAnuncio.length) {
                    return sock.sendMessage(jid, { text: 'ℹ️ Não há links novos e válidos para anunciar neste grupo.' }, { quoted: m });
                }
                const metaAnuncio = await sock.groupMetadata(jid);
                const botJidAnuncio = jidNormalizedUser(sock.user.id);
                const participantesAnuncio = metaAnuncio.participants.map((participante) => participante.id).filter((id) => id !== botJidAnuncio);
                for (const anuncio of pendentesAnuncio) {
                    if (!anuncio.anunciadoEm) anuncio.anunciadoEm = {};
                    anuncio.anunciadoEm[jid] = agoraAnuncio;
                    await sock.sendMessage(jid, {
                        text: `*Nova reunião*\n\n*${anuncio.texto}*\n\n🕒 Horário: *${anuncio.horario}*\n🔗 ${anuncio.link}`,
                        mentions: participantesAnuncio
                    }, { quoted: m });
                }
                salvarAnunciosLinks();
                break;
            }

            case 'eliminar': {
                if (!isSenderAdmin) return;
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: m });
                if (votacoesEliminacao[jid]?.ativa) return sock.sendMessage(jid, { text: '⚠️ Já existe uma votação aberta neste grupo.' }, { quoted: m });

                const indicados = [...new Set(mentions)];
                if (!indicados.length) return sock.sendMessage(jid, { text: '❌ Mencione pelo menos uma pessoa. Exemplo: *.eliminar @pessoa*' }, { quoted: m });
                const metaEliminacao = await sock.groupMetadata(jid);
                const participantesEliminacao = new Set(metaEliminacao.participants.map((p) => p.id));
                const indicadosValidos = indicados.filter((id) => participantesEliminacao.has(id) && id !== jidNormalizedUser(sock.user.id));
                if (!indicadosValidos.length) return sock.sendMessage(jid, { text: '❌ Nenhum indicado válido pertence a este grupo.' }, { quoted: m });

                votacoesEliminacao[jid] = { ativa: true, indicados: indicadosValidos, votos: {}, abertaPor: sender };
                const nomesIndicados = metaEliminacao.participants
                    .filter((p) => indicadosValidos.includes(p.id))
                    .map((p) => `• @${p.id.split('@')[0]}`)
                    .join('\n');
                return sock.sendMessage(jid, {
                    text: `🗳️ *VOTAÇÃO DE ELIMINAÇÃO ABERTA*\n\n${nomesIndicados}\n\nVote mencionando um indicado:\n*.votar @nome*\n\nApenas 1 voto por pessoa. O administrador encerra com *.encerrarvotos*.`,
                    mentions: indicadosValidos
                }, { quoted: m });
            }

            case 'votar': {
                if (!isGroup) return;
                const votacao = votacoesEliminacao[jid];
                if (!votacao?.ativa) return sock.sendMessage(jid, { text: '⚠️ Não existe votação aberta neste grupo.' }, { quoted: m });
                if (votacao.votos[sender]) return sock.sendMessage(jid, { text: '❌ Você já votou nesta votação.' }, { quoted: m });
                const indicadoVoto = mentions.find((id) => votacao.indicados.includes(id));
                if (!indicadoVoto) return sock.sendMessage(jid, { text: '❌ Mencione um dos indicados da votação.' }, { quoted: m });
                votacao.votos[sender] = indicadoVoto;
                return sock.sendMessage(jid, { text: `✅ Voto registrado para @${indicadoVoto.split('@')[0]}.`, mentions: [indicadoVoto] }, { quoted: m });
            }

            case 'encerrarvotos': {
                if (!isSenderAdmin) return;
                if (!isGroup) return;
                const votacao = votacoesEliminacao[jid];
                if (!votacao?.ativa) return sock.sendMessage(jid, { text: '⚠️ Não existe votação aberta neste grupo.' }, { quoted: m });

                const contagemVotos = Object.fromEntries(votacao.indicados.map((id) => [id, 0]));
                Object.values(votacao.votos).forEach((id) => { if (id in contagemVotos) contagemVotos[id]++; });
                const totalVotos = Object.values(contagemVotos).reduce((total, valor) => total + valor, 0);
                const vencedor = votacao.indicados.reduce((maior, id) => contagemVotos[id] > contagemVotos[maior] ? id : maior, votacao.indicados[0]);
                const metaResultado = await sock.groupMetadata(jid);
                const nomesResultado = metaResultado.participants.reduce((mapa, p) => { mapa[p.id] = p.notify || p.name || p.id.split('@')[0]; return mapa; }, {});
                const linhasResultado = votacao.indicados.map((id) => {
                    const percentual = totalVotos ? ((contagemVotos[id] / totalVotos) * 100).toFixed(1) : '0.0';
                    return `│ ${id === vencedor ? '🏆' : '▫️'} ${nomesResultado[id] || id.split('@')[0]}: *${contagemVotos[id]} voto(s) — ${percentual}%*`;
                }).join('\n');
                const mentionsResultado = votacao.indicados;
                votacao.ativa = false;
                await sock.sendMessage(jid, {
                    text: `╭─── [ 🗳️ *RESULTADO* ] ───╮\n${linhasResultado}\n╰───────────────────╯\n\n👤 Mais votado: @${vencedor.split('@')[0]}\n⏳ A eliminação acontecerá em 1 minuto.`,
                    mentions: mentionsResultado
                }, { quoted: m });

                setTimeout(async () => {
                    try {
                        const metaAtual = await sock.groupMetadata(jid);
                        const aindaNoGrupo = metaAtual.participants.some((p) => p.id === vencedor);
                        const botJid = jidNormalizedUser(sock.user.id);
                        const alvoPodeSerRemovido = vencedor !== botJid && vencedor !== DONO_SUPREMO && vencedor !== DONO_ADMIN;
                        if (aindaNoGrupo && alvoPodeSerRemovido) {
                            await sock.groupParticipantsUpdate(jid, [vencedor], 'remove');
                            await sock.sendMessage(jid, { text: `🚫 @${vencedor.split('@')[0]} foi removido por decisão da votação.`, mentions: [vencedor] });
                        }
                    } catch (errVoto) {
                        console.error('[votação] erro ao remover vencedor:', errVoto.message);
                        await sock.sendMessage(jid, { text: '❌ Não foi possível remover o mais votado. Verifique se o bot é administrador.' });
                    }
                }, 60 * 1000);
                break;
            }

            case 'criarsorteio': {
                if (!isSenderAdmin) return;
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: m });
                const premioSorteio = args.join(' ').trim();
                if (!premioSorteio) return sock.sendMessage(jid, { text: '❌ Informe o prêmio. Exemplo: *.criarsorteio Pix de 10 reais*' }, { quoted: m });
                if (sorteiosGrupo[jid]?.ativo) return sock.sendMessage(jid, { text: '⚠️ Já existe um sorteio aberto neste grupo.' }, { quoted: m });
                sorteiosGrupo[jid] = { ativo: true, premio: premioSorteio, participantes: new Set() };
                return sock.sendMessage(jid, { text: `🎁 *SORTEIO ABERTO!*\n\n🏆 Prêmio: *${premioSorteio}*\n\nPara participar, envie *.entrarsorteio*.` }, { quoted: m });
            }

            case 'entrarsorteio': {
                if (!isGroup) return;
                const sorteio = sorteiosGrupo[jid];
                if (!sorteio?.ativo) return sock.sendMessage(jid, { text: '⚠️ Não existe sorteio aberto neste grupo.' }, { quoted: m });
                if (sorteio.participantes.has(sender)) return sock.sendMessage(jid, { text: '⚠️ Você já está participando.' }, { quoted: m });
                sorteio.participantes.add(sender);
                return sock.sendMessage(jid, { text: `✅ @${sender.split('@')[0]} entrou no sorteio!`, mentions: [sender] }, { quoted: m });
            }

            case 'sorteaagora': {
                if (!isSenderAdmin) return;
                if (!isGroup) return;
                const sorteio = sorteiosGrupo[jid];
                if (!sorteio?.ativo) return sock.sendMessage(jid, { text: '⚠️ Não existe sorteio aberto neste grupo.' }, { quoted: m });
                const participantesSorteio = [...sorteio.participantes];
                if (!participantesSorteio.length) return sock.sendMessage(jid, { text: '❌ Ninguém entrou no sorteio ainda.' }, { quoted: m });
                await sock.sendMessage(jid, { text: '🎲 *SORTEANDO...*' }, { quoted: m });
                await new Promise((resolve) => setTimeout(resolve, 1500));
                const vencedorSorteio = participantesSorteio[Math.floor(Math.random() * participantesSorteio.length)];
                sorteio.ativo = false;
                return sock.sendMessage(jid, { text: `🎉 *SORTEIO FINALIZADO!*\n\n🏆 Prêmio: *${sorteio.premio}*\n👑 Vencedor: @${vencedorSorteio.split('@')[0]}\n\nParabéns!`, mentions: [vencedorSorteio] }, { quoted: m });
            }

            case 'logobot': {
                if (!isSenderAdmin) return;
                const quotedLogo = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                const imagemLogo = m.message.imageMessage || quotedLogo?.imageMessage;
                if (!imagemLogo) return sock.sendMessage(jid, { text: '❌ Envie ou responda a uma imagem usando *.logobot*.' }, { quoted: m });
                const streamLogo = await downloadContentFromMessage(imagemLogo, 'image');
                let bufferLogo = Buffer.alloc(0);
                for await (const chunk of streamLogo) bufferLogo = Buffer.concat([bufferLogo, chunk]);
                logoBot = bufferLogo;
                fs.writeFileSync(caminhoLogoBot, bufferLogo);
                return sock.sendMessage(jid, { text: '✅ Logo do bot registrada. Ela será enviada junto com o menu.' }, { quoted: m });
            }

            case 'menu':
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas administradores.' }, { quoted: m });
                if (logoBot) await sock.sendMessage(jid, { image: logoBot, caption: '📋 *Menu de comandos*' }, { quoted: m });
                await sock.sendMessage(jid, { text: '📚 *MENU DO ATRINO BOT*\n\nUse uma das opções abaixo:\n\n🎮 *.menu1* — Jogos e sorteios\n🛡️ *.menu2* — Administração e proteção\n🧰 *.menu3* — Ferramentas e triagem' }, { quoted: m });
                break;

            case 'menu1':
                if (!isSenderAdmin) return;
                await sock.sendMessage(jid, { text: '🎮 *MENU 1 — JOGOS E SORTEIOS*\n\n➥ *.uno* / *.entraruno* / *.iniciaruno*\n➥ *.encerraruno*\n➥ *.cidadedorme* / *.entrar <nome>*\n➥ *.eliminar @pessoa* — Abrir votação\n➥ *.votar @pessoa* — Votar\n➥ *.encerrarvotos* — Finalizar votação\n➥ *.criarsorteio <prêmio>*\n➥ *.entrarsorteio*\n➥ *.sorteaagora*\n➥ *.bot_sorteia* — Ativar/desativar pontos automáticos\n➥ *.ranking* — Pontos dos sorteios\n➥ *.mutar @pessoa* — Custa 1 ponto por 1 minuto\n➥ *.roubar @pessoa* — Tenta roubar 1 ponto (50% de chance)\n➥ *.meme <tema>* — Buscar meme relacionado\n➥ *.meme* — Meme aleatório\n➥ *.ativar_anagrama* / *.desativa_anagrama*' }, { quoted: m });
                break;

            case 'menu2':
                if (!isSenderAdmin) return;
                await sock.sendMessage(jid, { text: '🛡️ *MENU 2 — ADMINISTRAÇÃO E PROTEÇÃO*\n\n➥ *.blacklist* / *.unblacklist*\n➥ *.ban @pessoa*\n➥ *.adv* / *.unadv @pessoa*\n➥ *.mute* / *.desmute*\n➥ *.abrir* / *.fechar*\n➥ *.so_adm* — comandos do bot só para admins\n➥ *.programar HH:MM/HH:MM* — diário\n➥ *.programar HH:MM/HH:MM DD/MM* — data única\n➥ *.removerprogramacao* — remover horários deste grupo\n➥ *.imagem_sono* — imagem na abertura e no fechamento\n➥ *.textabertura <texto>* / *.textfechamento <texto>*\n➥ *.localocorrencias* — definir grupo que recebe ocorrências\n➥ *.registrarocorrencia* — ativar neste grupo\n➥ *.desregistrarocorrencia* — desativar neste grupo\n➥ *.ocorrencia* — encaminhar mensagem/foto como ocorrência\n➥ *.documento* — gerar relatório diário de uso em todos os grupos\n➥ *.totag*\n➥ *.flood* — Anti-flood\n➥ *.pickall* — Remover membros\n➥ *.apagar @pessoa*\n➥ *.logobot* — Registrar logo\n➥ *.notificar* / *.naonotificar*\n➥ *.desativa_bot*' }, { quoted: m });
                break;

            case 'menu3':
                if (!isSenderAdmin) return;
                await sock.sendMessage(jid, { text: '🧰 *MENU 3 — FERRAMENTAS E TRIAGEM*\n\n➥ *.registrar_grupo_triagem <código>*\n➥ *.ativar_triagem* / *.desativar_triagem*\n➥ *.ativar_fila* / *.desativar_fila*\n➥ *.triagem<código>* / *.finalizar*\n➥ *.aprovar <ticket>* / *.reprovar <ticket>*\n➥ *.registrar_link <link>*\n➥ *.registrar_adm @pessoa apelido senha*\n➥ *.login_triagem senha*\n➥ *.metas* / *.alterar_meta <número>*\n➥ *.anunciar_link <link> <HH:MM> <texto>*\n➥ *.anunciar* — Publicar links pendentes\n➥ *.voz <texto>* — Texto em áudio\n➥ *.play <música>*\n➥ *.cep <cep>*\n➥ *.brat <texto>*\n➥ *.s* — Figurinha\n➥ *.a* — Figurinha animada\n➥ *.mat @pessoa*\n➥ *.perfil* / *.registrar*\n➥ *.ranking* / *.relatorio*' }, { quoted: m });
                break;

            case 'flood':
                if (!isSenderAdmin) return;
                floodAtivo[jid] = !floodAtivo[jid];
                if (floodAtivo[jid]) {
                    Object.keys(floodContagem).forEach(k => {
                        if (k.startsWith(jid + '|')) delete floodContagem[k];
                    });
                    await sock.sendMessage(jid, { text: `🛡️ *ANTI-FLOOD ATIVADO!*\n\nQuem enviar a mesma *foto* ou *figurinha* mais de *${FLOOD_LIMITE}x* será removido automaticamente.\n⏱️ Janela: 5 minutos.` }, { quoted: m });
                } else {
                    await sock.sendMessage(jid, { text: '🔕 Anti-flood desativado.' }, { quoted: m });
                }
                break;

case 'uno': {
                if (!isSenderAdmin) return;
                if (unoGame.ativo || unoGame.emAndamento) return sock.sendMessage(jid, { text: '❌ Já existe um UNO em andamento.' });
                unoGame = { ativo: true, emAndamento: false, jogadores: [], baralho: [], descarte: [], jogadorVez: 0, corAtual: null, sentido: 1, grupo: jid, cartasPorHash: {}, aguardandoCor: null, pularAposCor: false };
                return sock.sendMessage(jid, { text: '🃏 *UNO — Inscrições abertas!*\n\nUse *.entraruno <seu nome>* para participar.\nMínimo 2. O adm usa *.iniciaruno* para começar.' });
            }

            case 'entraruno': {
                if (!unoGame.ativo) return sock.sendMessage(jid, { text: '❌ Nenhum UNO aberto. Aguarde *.uno*.' });
                if (unoGame.emAndamento) return sock.sendMessage(jid, { text: '❌ Já começou!' });
                const nome = args.join(' ').trim();
                if (!nome) return sock.sendMessage(jid, { text: '❌ Informe seu nome! Ex: *.entraruno João*' });
                if (unoGame.jogadores.some(j => j.jid === sender)) return sock.sendMessage(jid, { text: '❌ Você já está no jogo!' });
                unoGame.jogadores.push({ jid: sender, nome, mao: [] });
                return sock.sendMessage(jid, { text: `✅ *${nome}* entrou!\n🃏 Jogadores: ${unoGame.jogadores.length}` });
            }

            case 'iniciaruno': {
                if (!isSenderAdmin) return;
                if (!unoGame.ativo) return sock.sendMessage(jid, { text: '❌ Use *.uno* primeiro.' });
                if (unoGame.emAndamento) return;
                if (unoGame.jogadores.length < 2) return sock.sendMessage(jid, { text: '❌ Mínimo 2 jogadores.' });
                unoGame.emAndamento = true; unoGame.ativo = false;
                unoGame.baralho = criarBaralhoUno();
                await sock.sendMessage(jid, { text: '🃏 *UNO INICIADO!*\nDistribuindo 7 cartas no privado... Aguarde!' });
                for (const jogador of unoGame.jogadores) {
                    jogador.mao = [];
                    for (let i = 0; i < 7; i++) { if (!unoGame.baralho.length) unoGame.baralho = criarBaralhoUno(); jogador.mao.push(unoGame.baralho.pop()); }
                    for (const carta of jogador.mao) { await enviarCartaSticker(sock, jogador.jid, carta, unoGame); await new Promise(r => setTimeout(r, 700)); }
                    await sock.sendMessage(jogador.jid, { text: '✅ Você recebeu 7 cartas! Salve todas. Quando for sua vez, envie a carta no grupo.' });
                }
                let primeira;
                do {
                    const c = unoGame.baralho.pop();
                    if (c.cor === 'wild') { unoGame.baralho.unshift(c); } else { primeira = c; }
                } while (!primeira);
                unoGame.descarte.push(primeira);
                unoGame.corAtual = primeira.cor;
                if (primeira.valor === 'reverse') unoGame.sentido = -1;
                if (primeira.valor === 'skip') unoGame.jogadorVez = proxIdx(unoGame);
                await anunciarVezUno(sock, unoGame);
                break;
            }

            case 'puxar': {
                if (!unoGame.emAndamento) return;
                if (unoGame.aguardandoCor) return sock.sendMessage(jid, { text: '⏳ Aguardando escolha de cor.' });
                const j = unoGame.jogadores[unoGame.jogadorVez];
                if (j.jid !== sender) return sock.sendMessage(jid, { text: `⏳ Não é sua vez!` });
                if (!unoGame.baralho.length) unoGame.baralho = criarBaralhoUno();
                const c = unoGame.baralho.pop();
                j.mao.push(c);
                await enviarCartaSticker(sock, sender, c, unoGame);
                await sock.sendMessage(sender, { text: `📥 Você comprou: ${descCarta(c)}` });
                unoGame.jogadorVez = proxIdx(unoGame);
                await anunciarVezUno(sock, unoGame);
                break;
            }

            case 'cor': {
                if (!unoGame.emAndamento || !unoGame.aguardandoCor) return;
                if (sender !== unoGame.aguardandoCor) return sock.sendMessage(jid, { text: '❌ Não é você quem escolhe a cor.' });
                const mapa = { vermelho: 'red', azul: 'blue', amarelo: 'yellow', verde: 'green', red: 'red', blue: 'blue', yellow: 'yellow', green: 'green' };
                const cor = mapa[args[0]?.toLowerCase()];
                if (!cor) return sock.sendMessage(jid, { text: '❌ Use: *.cor vermelho/azul/amarelo/verde*' });
                unoGame.corAtual = cor;
                unoGame.aguardandoCor = null;
                const pular = unoGame.pularAposCor;
                unoGame.pularAposCor = false;
                unoGame.jogadorVez = (unoGame.jogadorVez + (pular ? 2 : 1) * unoGame.sentido + unoGame.jogadores.length) % unoGame.jogadores.length;
                await sock.sendMessage(jid, { text: `🎨 Cor definida: ${UNO_COR_EMOJI[cor]} ${UNO_CORES_PT[cor]}` });
                await anunciarVezUno(sock, unoGame);
                break;
            }

            case 'mao': {
                if (!unoGame.emAndamento) return;
                const j = unoGame.jogadores.find(j => j.jid === sender);
                if (!j) return;
                return sock.sendMessage(jid, { text: `🃏 Você tem ${j.mao.length} carta(s).\n\n${recapCartas(unoGame)}` });
            }

            case 'encerraruno': {
                if (!isSenderAdmin) return;
                unoGame = { ativo: false, emAndamento: false, jogadores: [], baralho: [], descarte: [], jogadorVez: 0, corAtual: null, sentido: 1, grupo: null, cartasPorHash: {}, aguardandoCor: null, pularAposCor: false };
                await sock.sendMessage(jid, { text: '🛑 UNO encerrado.' });
                break;
            }
            
case 'perfil': {
                let alvoPerfil = getMention() || sender;
                const p = perfis[alvoPerfil];
                if (!p) {
                    return sock.sendMessage(jid, { text: `❌ @${alvoPerfil.split('@')[0]} ainda não criou perfil.\n\nNo PV do bot use *.registrar*.`, mentions: [alvoPerfil] }, { quoted: m });
                }
                let ppUrl;
                try { ppUrl = await sock.profilePictureUrl(alvoPerfil, 'image'); }
                catch { ppUrl = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png'; }

                const count = interacaoPerfil[alvoPerfil] || 0;
                let nivel, statusTxt;
                if (count < 10)        { nivel = 1;  statusTxt = '📉 Quase inativo'; }
                else if (count < 30)   { nivel = 3;  statusTxt = '😐 Pouco ativo'; }
                else if (count < 80)   { nivel = 5;  statusTxt = '🙂 Ativo'; }
                else if (count < 200)  { nivel = 7;  statusTxt = '😀 Muito ativo'; }
                else if (count < 500)  { nivel = 9;  statusTxt = '🔥 Super ativo'; }
                else                   { nivel = 10; statusTxt = '🚀 LENDA do grupo'; }
                const barra = '█'.repeat(nivel) + '░'.repeat(10 - nivel);

                const legendaPerfil = `╭─── [ 👤 *PERFIL* ] ───╮
│
│  🏷️ *Nome:* ${p.nome}
│  🎂 *Idade:* ${p.idade}
│  🏳️‍🌈 *Sexualidade:* ${p.sexualidade}
│  🎮 *Hobbies:* ${p.hobbies}
│  💍 *Estado civil:* ${p.estadoCivil}
│
│  📊 *Interação:* ${statusTxt}
│  [${barra}] ${count} msgs
│
╰───────────────────╯`;

                try {
                    await sock.sendMessage(jid, { image: { url: ppUrl }, caption: legendaPerfil, mentions: [alvoPerfil] }, { quoted: m });
                } catch {
                    await sock.sendMessage(jid, { text: legendaPerfil, mentions: [alvoPerfil] }, { quoted: m });
                }
                break;
            }
            
            case 'blacklist': {
                if (!isSenderAdmin) return;
                const alvoBl = getMention() || m.message.extendedTextMessage?.contextInfo?.participant;
                if (!alvoBl) return sock.sendMessage(jid, { text: '❌ Mencione ou responda a mensagem de quem banir.\n\nExemplo: *.blacklist @user*' }, { quoted: m });
                if (alvoBl === DONO_SUPREMO || alvoBl === DONO_ADMIN) return sock.sendMessage(jid, { text: '❌ Não pode banir o dono.' }, { quoted: m });
                let alvoEhAdminBl = false;
                try { const metaBl = await sock.groupMetadata(jid); alvoEhAdminBl = metaBl.participants.filter(p => p.admin).map(p => p.id).includes(alvoBl); } catch {}
                if (alvoEhAdminBl) return sock.sendMessage(jid, { text: '❌ Não pode colocar um admin na blacklist.' }, { quoted: m });
                if (!blacklist[jid]) blacklist[jid] = [];
                if (blacklist[jid].includes(alvoBl)) return sock.sendMessage(jid, { text: '⚠️ @${alvoBl.split("@")[0]} já está na blacklist.'.replace('@{' + alvoBl.split('@')[0], '@' + alvoBl.split('@')[0]), mentions: [alvoBl] }, { quoted: m });
                blacklist[jid].push(alvoBl);
                try { await sock.groupParticipantsUpdate(jid, [alvoBl], 'remove'); } catch {}
                await sock.sendMessage(jid, {
                    text: `🚫 *BLACKLIST*\n\n@${alvoBl.split('@')[0]} foi banido e se retornar ao grupo será removido automaticamente.`,
                    mentions: [alvoBl]
                }, { quoted: m });
                break;
            }

            case 'unblacklist': {
                if (!isSenderAdmin) return;
                const alvoUn = getMention() || m.message.extendedTextMessage?.contextInfo?.participant;
                if (!alvoUn || !blacklist[jid]?.includes(alvoUn)) return sock.sendMessage(jid, { text: '❌ Pessoa não está na blacklist.' }, { quoted: m });
                blacklist[jid] = blacklist[jid].filter(x => x !== alvoUn);
                await sock.sendMessage(jid, { text: `✅ @${alvoUn.split('@')[0]} removido da blacklist.`, mentions: [alvoUn] }, { quoted: m });
                break;
            }

            case 'programar': {
                if (!isSenderAdmin) return;
                const textoProg = args.join(' ').trim();
                const matchProg = textoProg.match(/^((?:[01]\d|2[0-3]):[0-5]\d)\/((?:[01]\d|2[0-3]):[0-5]\d)(?:\s+(\d{2}\/\d{2}))?$/);
                if (!matchProg) return sock.sendMessage(jid, { text: '❌ Formato inválido!\n\nTodos os dias: *.programar 22:00/06:00*\nUma única data: *.programar 00:00/06:00 09/08*' }, { quoted: m });
                const [, horaFecha, horaAbre, dataProg] = matchProg;
                if (dataProg) {
                    const [diaProg, mesProg] = dataProg.split('/').map(Number);
                    const diasNoMes = new Date(2000, mesProg, 0).getDate();
                    if (mesProg < 1 || mesProg > 12 || diaProg < 1 || diaProg > diasNoMes) {
                        return sock.sendMessage(jid, { text: '❌ Data inválida. Use uma data real no formato DD/MM.' }, { quoted: m });
                    }
                }
                const recorrente = !dataProg;
                const agendamento = {
                    grupo: jid, horaFecha, horaAbre, dataProg: dataProg || null,
                    recorrente, criadoEm: Date.now(), fechado: false, aberto: false,
                    executado: false, ultimoFechamento: null, ultimaAbertura: null
                };
                const haviaAgendamento = agendamentos.some((ag) => ag.grupo === jid);
                agendamentos = agendamentos.filter((ag) => ag.grupo !== jid);
                agendamentos.push(agendamento);
                const persistido = await syncEstadoBotToGithub();
                const detalheData = recorrente ? '📅 Todos os dias' : `📅 Data única: ${dataProg}`;
                const avisoPersistencia = persistido ? 'Salvo para continuar após reinícios.' : '⚠️ GitHub indisponível: este agendamento só fica ativo até o bot reiniciar.';
                const avisoSubstituicao = haviaAgendamento ? 'O horário anterior deste grupo foi substituído.\n' : '';
                await sock.sendMessage(jid, { text: `✅ *AGENDAMENTO*\n\n🔒 Fecha: ${horaFecha}\n🔓 Abre: ${horaAbre}\n${detalheData}\n\n${avisoSubstituicao}O grupo será controlado automaticamente.\n${avisoPersistencia}` }, { quoted: m });
                break;
            }

            case 'removerprogramacao':
            case 'removerhorario': {
                if (!isSenderAdmin) return;
                const quantidadeRemovida = agendamentos.filter((ag) => ag.grupo === jid).length;
                if (!quantidadeRemovida) {
                    return sock.sendMessage(jid, { text: 'ℹ️ Este grupo não tem horários agendados.' }, { quoted: m });
                }
                agendamentos = agendamentos.filter((ag) => ag.grupo !== jid);
                const persistido = await syncEstadoBotToGithub();
                const avisoPersistencia = persistido
                    ? 'A remoção foi salva.'
                    : '⚠️ Não consegui salvar no GitHub; a remoção vale até o bot reiniciar.';
                await sock.sendMessage(jid, { text: `✅ ${quantidadeRemovida} agendamento(s) removido(s) deste grupo.\n${avisoPersistencia}` }, { quoted: m });
                break;
            }

            case 'inativo': {
                if (!isSenderAdmin) return;
                inativoAtivo[jid] = !inativoAtivo[jid];
                if (inativoAtivo[jid]) {
                    await sock.sendMessage(jid, { text: '🧹 *MODO INATIVO ATIVADO!*\n\nMembros com 30 dias sem enviar mensagens serão removidos automaticamente.' }, { quoted: m });
                } else {
                    await sock.sendMessage(jid, { text: '🔕 Modo inativo desativado.' }, { quoted: m });
                }
                break;
            }
            
case 'cidadedorme': {
                if (!isSenderAdmin) return;
                if (!jogoCidade.ativo) {
                    jogoCidade = { ativo: true, emAndamento: false, jogadores: [], assassino: null, xerife: null, aguardando: null, grupo: jid };
                    return sock.sendMessage(jid, {
                        text: '🌙 *CIDADE DORME — Inscrições abertas!*\n\nUse *.entrar <seu nome>* para participar.\n\nMínimo 3 jogadores. O adm usa *.cidadedorme* de novo para iniciar.'
                    }, { quoted: m });
                }
                if (jogoCidade.emAndamento) return sock.sendMessage(jid, { text: '❌ O jogo já está em andamento.' }, { quoted: m });
                if (jogoCidade.jogadores.length < 3) return sock.sendMessage(jid, { text: `❌ Apenas ${jogoCidade.jogadores.length} jogador(es). Mínimo de 3.` }, { quoted: m });

                // Inicia o jogo
                jogoCidade.emAndamento = true;
                jogoCidade.ativo = false;
                jogoCidade.grupo = jid;

                const idxAss = Math.floor(Math.random() * jogoCidade.jogadores.length);
                jogoCidade.assassino = jogoCidade.jogadores[idxAss].jid;
                let idxSher = Math.floor(Math.random() * jogoCidade.jogadores.length);
                while (idxSher === idxAss) idxSher = Math.floor(Math.random() * jogoCidade.jogadores.length);
                jogoCidade.xerife = jogoCidade.jogadores[idxSher].jid;

                for (const j of jogoCidade.jogadores) {
                    let papel = '🧑 *INOCENTE* — Sobreviva e ajude o xerife!';
                    if (j.jid === jogoCidade.assassino) papel = '🔪 *ASSASSINO* — Elimine todos sem ser pego!';
                    else if (j.jid === jogoCidade.xerife) papel = '⭐ *XERIFE* — Descubra quem é o assassino!';
                    await sock.sendMessage(j.jid, { text: `🌙 *CIDADE DORME*\n\nSeu papel: ${papel}\n\nNome: ${j.nome}` });
                }

                await sock.sendMessage(jid, {
                    text: `🌙 *O JOGO COMEÇOU!*\n\n👥 ${jogoCidade.jogadores.length} jogadores\n🎭 Papéis enviados no privado.\n\nO xerife será questionado primeiro...`
                }, { quoted: m });

                await pedirXerife(sock, jogoCidade);
                break;
            }

            // ============================================================
            // .entrar <nome> — entra na partida
            // ============================================================
            case 'entrar': {
                if (isDM) return;
                if (!jogoCidade.ativo) return sock.sendMessage(jid, { text: '❌ Nenhum jogo aberto. Aguarde o adm usar *.cidadedorme*' }, { quoted: m });
                if (jogoCidade.emAndamento) return sock.sendMessage(jid, { text: '❌ O jogo já começou!' }, { quoted: m });
                const nome = args.join(' ').trim();
                if (!nome) return sock.sendMessage(jid, { text: '❌ Informe seu nome!\n\nExemplo: *.entrar João*' }, { quoted: m });
                if (jogoCidade.jogadores.some(j => j.jid === sender)) return sock.sendMessage(jid, { text: '❌ Você já está no jogo!' }, { quoted: m });
                jogoCidade.jogadores.push({ jid: sender, nome });
                console.log('[entrar] jogador registrado:', nome, '| jid:', sender, '| total:', jogoCidade.jogadores.length);
                return sock.sendMessage(jid, { text: `✅ *${nome}* entrou no jogo!\n👥 Jogadores: ${jogoCidade.jogadores.length}` }, { quoted: m });
            }

            
            // ============================================================
            // .imagem — registra a imagem usada pelo .comer (admin)
            // ============================================================
            case 'imagem_sono': {
                if (!isSenderAdmin) return;
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Use .imagem_sono dentro de um grupo.' }, { quoted: m });
                const imagemCitada = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                const imagemRecebida = m.message.imageMessage || imagemCitada?.imageMessage;
                if (!imagemRecebida) {
                    return sock.sendMessage(jid, { text: '❌ Envie uma imagem com a legenda .imagem_sono ou responda a uma imagem com esse comando.' }, { quoted: m });
                }
                try {
                    const stream = await downloadContentFromMessage(imagemRecebida, 'image');
                    let buffer = Buffer.alloc(0);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    fs.writeFileSync(caminhoImagemSono, buffer);
                    imagemSono = buffer;
                    await sock.sendMessage(jid, { text: '✅ Imagem registrada. Ela será enviada tanto na abertura quanto no fechamento do grupo.' }, { quoted: m });
                } catch (errImagemSono) {
                    console.error('[imagem_sono] erro ao registrar:', errImagemSono.message);
                    await sock.sendMessage(jid, { text: '❌ Não consegui registrar essa imagem.' }, { quoted: m });
                }
                break;
            }

            case 'localocorrencias': {
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas administradores podem definir o grupo de ocorrências.' }, { quoted: m });
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Use este comando dentro do grupo que receberá as ocorrências.' }, { quoted: m });
                const grupoAnteriorOcorrencias = grupoLocalOcorrencias;
                grupoLocalOcorrencias = jid;
                if (!await syncEstadoBotToGithub()) {
                    grupoLocalOcorrencias = grupoAnteriorOcorrencias;
                    return sock.sendMessage(jid, { text: '❌ Não consegui salvar o grupo de ocorrências no GitHub. Confira a configuração e tente novamente.' }, { quoted: m });
                }
                await sock.sendMessage(jid, { text: '✅ Este grupo agora receberá as ocorrências encaminhadas pelos grupos ativados.' }, { quoted: m });
                break;
            }

            case 'registrarocorrencia': {
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas administradores podem ativar o registro de ocorrências.' }, { quoted: m });
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Use este comando dentro do grupo onde as ocorrências poderão ser registradas.' }, { quoted: m });
                if (!grupoLocalOcorrencias) {
                    return sock.sendMessage(jid, { text: '❌ Primeiro configure o grupo destinatário usando *.localocorrencias* nele.' }, { quoted: m });
                }
                const estadoAnteriorOcorrencias = gruposOcorrenciaAtivos[jid] === true;
                gruposOcorrenciaAtivos[jid] = true;
                if (!await syncEstadoBotToGithub()) {
                    if (estadoAnteriorOcorrencias) gruposOcorrenciaAtivos[jid] = true;
                    else delete gruposOcorrenciaAtivos[jid];
                    return sock.sendMessage(jid, { text: '❌ Não consegui salvar a ativação no GitHub. Confira a configuração e tente novamente.' }, { quoted: m });
                }
                await sock.sendMessage(jid, { text: `✅ Registro de ocorrências ativado. Use *.ocorrencia* respondendo a uma mensagem ou junto com uma foto.\n\nAs ocorrências serão enviadas para o grupo destinatário configurado.` }, { quoted: m });
                break;
            }

            case 'desregistrarocorrencia': {
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas administradores podem desativar o registro de ocorrências.' }, { quoted: m });
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Use este comando dentro do grupo que deseja desativar.' }, { quoted: m });
                if (gruposOcorrenciaAtivos[jid] !== true) {
                    return sock.sendMessage(jid, { text: 'ℹ️ O registro de ocorrências já está desativado neste grupo.' }, { quoted: m });
                }
                delete gruposOcorrenciaAtivos[jid];
                if (!await syncEstadoBotToGithub()) {
                    gruposOcorrenciaAtivos[jid] = true;
                    return sock.sendMessage(jid, { text: '❌ Não consegui salvar a desativação no GitHub. Tente novamente.' }, { quoted: m });
                }
                await sock.sendMessage(jid, { text: '🔕 Registro de ocorrências desativado neste grupo.' }, { quoted: m });
                break;
            }

            case 'ocorrencia': {
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Este comando só pode ser usado em um grupo.' }, { quoted: m });
                if (gruposOcorrenciaAtivos[jid] !== true) {
                    return sock.sendMessage(jid, { text: '❌ O registro de ocorrências não está ativado neste grupo.' }, { quoted: m });
                }
                if (!grupoLocalOcorrencias) {
                    return sock.sendMessage(jid, { text: '❌ O grupo destinatário das ocorrências ainda não foi configurado.' }, { quoted: m });
                }

                const mensagemCitadaOcorrencia = contextoMensagem.quotedMessage;
                const imagemOcorrencia = m.message.imageMessage
                    || mensagemCitadaOcorrencia?.imageMessage
                    || mensagemCitadaOcorrencia?.viewOnceMessage?.message?.imageMessage
                    || mensagemCitadaOcorrencia?.viewOnceMessageV2?.message?.imageMessage;
                const textoCitadoOcorrencia = mensagemCitadaOcorrencia?.conversation
                    || mensagemCitadaOcorrencia?.extendedTextMessage?.text
                    || mensagemCitadaOcorrencia?.imageMessage?.caption
                    || mensagemCitadaOcorrencia?.videoMessage?.caption
                    || '';
                const detalhesOcorrencia = args.join(' ').trim();

                if (!imagemOcorrencia && !textoCitadoOcorrencia && !detalhesOcorrencia) {
                    return sock.sendMessage(jid, {
                        text: '❌ Para registrar, responda à mensagem com *.ocorrencia* ou envie uma foto com a legenda *.ocorrencia*.\nVocê também pode adicionar detalhes: *.ocorrencia <detalhes>*'
                    }, { quoted: m });
                }

                const dataOcorrencia = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                const autorOcorrencia = mensagemCitadaOcorrencia
                    ? (contextoMensagem.participant || sender)
                    : sender;
                const cabecalhoOcorrencia = `🚨 *NOVA OCORRÊNCIA*\n📍 Grupo de origem: ${jid}\n👤 Registrada por: @${sender.split('@')[0]}\n🕒 Data: ${dataOcorrencia}`;
                const partesOcorrencia = [cabecalhoOcorrencia];
                if (mensagemCitadaOcorrencia) {
                    partesOcorrencia.push(`✉️ Mensagem de: @${autorOcorrencia.split('@')[0]}`);
                }
                if (textoCitadoOcorrencia) partesOcorrencia.push(`📝 Mensagem registrada:\n${textoCitadoOcorrencia}`);
                if (detalhesOcorrencia) partesOcorrencia.push(`📌 Detalhes:\n${detalhesOcorrencia}`);
                const mencoesOcorrencia = [...new Set([sender, ...(mensagemCitadaOcorrencia ? [autorOcorrencia] : [])])];

                try {
                    if (imagemOcorrencia) {
                        const streamOcorrencia = await downloadContentFromMessage(imagemOcorrencia, 'image');
                        const partesImagemOcorrencia = [];
                        for await (const parte of streamOcorrencia) partesImagemOcorrencia.push(parte);
                        await sock.sendMessage(grupoLocalOcorrencias, {
                            text: partesOcorrencia.join('\n\n'),
                            mentions: mencoesOcorrencia
                        });
                        await sock.sendMessage(grupoLocalOcorrencias, {
                            image: Buffer.concat(partesImagemOcorrencia),
                            caption: `📷 Imagem anexada à ocorrência registrada por @${sender.split('@')[0]}.`,
                            mentions: [sender]
                        });
                    } else {
                        await sock.sendMessage(grupoLocalOcorrencias, {
                            text: partesOcorrencia.join('\n\n'),
                            mentions: mencoesOcorrencia
                        });
                    }
                    try {
                        analiseDiaria.registrarEvento('ocorrencia', jid);
                    } catch (erroRegistro) {
                        console.error('[documento] falha ao salvar ocorrência nas estatísticas:', erroRegistro.message);
                    }
                    await sock.sendMessage(jid, { text: '✅ Ocorrência enviada ao grupo responsável.' }, { quoted: m });
                } catch (errOcorrencia) {
                    console.error('[ocorrencia] falha ao encaminhar:', errOcorrencia.message);
                    await sock.sendMessage(jid, { text: '❌ Não consegui concluir o envio da ocorrência. Se o grupo destinatário recebeu apenas o texto ou a imagem, confira antes de tentar novamente.' }, { quoted: m });
                }
                break;
            }

            case 'textabertura':
            case 'textfechamento': {
                if (!isSenderAdmin) return;
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Use este comando dentro do grupo que deseja configurar.' }, { quoted: m });
                const abertura = command === 'textabertura';
                const textos = abertura ? textosAberturaPorGrupo : textosFechamentoPorGrupo;
                const textoNovo = args.join(' ').trim();
                if (!textoNovo) {
                    const padrao = abertura
                        ? '🌞 Bom dia, pessoal! O grupo está aberto novamente. Tenham um ótimo dia!'
                        : '🌙 Boa noite, pessoal! O grupo está fechado para descanso. Durmam bem e até amanhã!';
                    return sock.sendMessage(jid, {
                        text: `📝 Texto atual de ${abertura ? 'abertura' : 'fechamento'}:\n\n${textos[jid] || padrao}\n\nPara alterar, use *.${command} <mensagem>*`
                    }, { quoted: m });
                }
                if (textoNovo.length > 1000) {
                    return sock.sendMessage(jid, { text: '❌ O texto pode ter no máximo 1000 caracteres.' }, { quoted: m });
                }
                textos[jid] = textoNovo;
                const persistido = await syncEstadoBotToGithub();
                const avisoPersistencia = persistido
                    ? ''
                    : '\n⚠️ Não consegui salvar no GitHub; a alteração vale até o bot reiniciar.';
                await sock.sendMessage(jid, { text: `✅ Texto de ${abertura ? 'abertura' : 'fechamento'} atualizado.${avisoPersistencia}` }, { quoted: m });
                break;
            }

            case 'imagem': {
                if (!isSenderAdmin) return;
                try {
                    const quotedImg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const imgImagem = m.message.imageMessage || quotedImg?.imageMessage;
                    const vidGif    = m.message.videoMessage || quotedImg?.videoMessage;

                    if (imgImagem) {
                        // É imagem
                        const stream = await downloadContentFromMessage(imgImagem, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        imagemComer = { tipo: 'image', buffer };
                        await sock.sendMessage(jid, { text: '✅ *Imagem registrada!* O *.comer* vai usar essa imagem.' }, { quoted: m });
                    } else if (vidGif) {
                        // É gif/vídeo
                        if (vidGif.seconds > 15) return sock.sendMessage(jid, { text: '❌ GIF muito longo! Máximo 15 segundos.' }, { quoted: m });
                        const stream = await downloadContentFromMessage(vidGif, 'video');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        imagemComer = { tipo: 'video', buffer, gifPlayback: true };
                        await sock.sendMessage(jid, { text: '✅ *GIF registrado!* O *.comer* vai usar esse GIF.' }, { quoted: m });
                    } else {
                        return sock.sendMessage(jid, { text: '❌ Envie ou responda uma *imagem* ou *GIF* com *.imagem*' }, { quoted: m });
                    }
                } catch (errImg) {
                    console.error('[imagem] erro:', errImg.message);
                    await sock.sendMessage(jid, { text: '�� Erro ao registrar mídia.' }, { quoted: m });
                }
                break;
            }

            // ============================================================
            // .comer @pessoa — envia imagem + "@sender comeu @alvo"
            // ============================================================
            case 'comer': {
                const alvoComer = getMention() || m.message.extendedTextMessage?.contextInfo?.participant;
                if (!alvoComer) return sock.sendMessage(jid, { text: '❌ Mencione alguém!\n\nExemplo: *.comer @pessoa*' }, { quoted: m });

                const captionComer = `🍽️ *@${sender.split('@')[0]}* comeu *@${alvoComer.split('@')[0]}*! 😋`;

                if (!imagemComer) {
                    return sock.sendMessage(jid, { text: captionComer, mentions: [sender, alvoComer] }, { quoted: m });
                }

                if (imagemComer.tipo === 'video') {
                    await sock.sendMessage(jid, {
                        video: imagemComer.buffer,
                        gifPlayback: true,
                        caption: captionComer,
                        mentions: [sender, alvoComer]
                    });
                } else {
                    await sock.sendMessage(jid, {
                        image: imagemComer.buffer,
                        caption: captionComer,
                        mentions: [sender, alvoComer]
                    });
                }
                break;
            }

            case 'meme': {
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ O comando *.meme* só pode ser usado em grupos.' }, { quoted: m });
                const termoMeme = args.join(' ').trim();
                if (termoMeme.length > 100) {
                    return sock.sendMessage(jid, { text: '❌ O tema da busca pode ter no máximo 100 caracteres.' }, { quoted: m });
                }
                try {
                    await sock.sendMessage(jid, {
                        text: termoMeme ? `🔎 Procurando um meme sobre *${termoMeme}*...` : '🔎 Procurando um meme aleatório...'
                    }, { quoted: m });
                    const meme = await buscarMemeSeguro(termoMeme);
                    const origem = meme.subreddit ? `\nr/${meme.subreddit}` : '';
                    await sock.sendMessage(jid, {
                        image: meme.buffer,
                        caption: `😂 *${meme.titulo.slice(0, 500)}*${origem}\n\n🌐 Fonte: Reddit`
                    });
                } catch (errMeme) {
                    console.error('[meme] falha ao buscar ou enviar meme:', errMeme.message);
                    await sock.sendMessage(jid, {
                        text: termoMeme
                            ? `❌ Não encontrei um meme em imagem sobre *${termoMeme}*. Tente outro tema ou use *.meme* para um meme aleatório.`
                            : '❌ Não consegui buscar um meme agora. Tente novamente daqui a pouco.'
                    }, { quoted: m });
                }
                break;
            }

case 'play': {
    if (!isSenderAdmin) return;
    const termoPlay = args.join(' ').trim();
    if (!termoPlay) {
        return sock.sendMessage(jid, {
            text: '❌ Digite o nome da música!\n\nExemplo: *.play the weeknd blinding lights*'
        }, { quoted: m });
    }

    try {
        const play = require('play-dl');

        // Configura o Client ID do SoundCloud
        const scClientID = await play.getFreeClientID();
        await play.setToken({
            soundcloud: {
                client_id: scClientID
            }
        });

        await sock.sendMessage(jid, { react: { text: '🔎', key: m.key } });
        await sock.sendMessage(jid, { text: `🔎 Buscando no SoundCloud: *${termoPlay}*...` }, { quoted: m });

        const searchResults = await play.search(termoPlay, { source: { soundcloud: 'tracks' }, limit: 1 });

        if (!searchResults || searchResults.length === 0) {
            await sock.sendMessage(jid, { react: { text: '❌', key: m.key } });
            return sock.sendMessage(jid, { text: '❌ Nenhuma música encontrada.' }, { quoted: m });
        }

        const track = searchResults[0];
        const titulo = track.title || 'Sem título';
        const artista = track.publisher?.artist || track.user?.name || 'Desconhecido';
        const duracao = track.durationInSec || '?';
        const link = track.url;
        const thumb = track.thumbnail;

        await sock.sendMessage(jid, { react: { text: '⏬', key: m.key } });

        if (thumb) {
            try {
                const thumbResp = await axios.get(thumb, { responseType: 'arraybuffer', timeout: 15000 });
                const thumbBuffer = Buffer.from(thumbResp.data, 'binary');
                await sock.sendMessage(jid, {
                    image: thumbBuffer,
                    caption: `🎵 *Música encontrada!*\n\n📌 *${titulo}*\n👤 ${artista}\n⏱️ ${duracao}s\n\n⏳ Baixando áudio...`
                }, { quoted: m });
            } catch {
                await sock.sendMessage(jid, { text: `🎵 *Música encontrada!*\n\n📌 *${titulo}*\n👤 ${artista}\n⏱️ ${duracao}s\n\n⏳ Baixando áudio...` }, { quoted: m });
            }
        } else {
            await sock.sendMessage(jid, { text: `🎵 *Música encontrada!*\n\n📌 *${titulo}*\n👤 ${artista}\n⏱️ ${duracao}s\n\n⏳ Baixando áudio...` }, { quoted: m });
        }

        // Gera a stream do áudio
        const stream = await play.stream(link);
        const chunks = [];
        for await (const chunk of stream.stream) {
            chunks.push(chunk);
        }
        const audioBuffer = Buffer.concat(chunks);

        // Envia como player de áudio funcional sem corromper
        await sock.sendMessage(jid, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: false
        }, { quoted: m });

        await sock.sendMessage(jid, { react: { text: '✅', key: m.key } });
    } catch (errPlay) {
        console.error('[play] erro:', errPlay.message);
        await sock.sendMessage(jid, { react: { text: '❌', key: m.key } });
        return sock.sendMessage(jid, {
            text: '❌ Erro ao buscar/baixar a música. Tente novamente.'
        }, { quoted: m });
    }
    break;
}
            
            case 'pickall': {
                if (!isSenderAdmin) return;
                const senhaPick = args[0];

                if (!senhaPick) {
                    pickallPendente[jid] = { sender, timestamp: Date.now() };
                    return sock.sendMessage(jid, {
                        text: `⚠️ *PICKALL — CONFIRMAÇÃO NECESSÁRIA*\n\n🚨 Esta ação vai remover TODOS os membros do grupo (exceto você e o bot).\n\n🔐 Para confirmar, envie:\n\n*.pickall 1717*\n\n❌ Para cancelar, simplesmente ignore.`,
                        mentions: [sender]
                    }, { quoted: m });
                }

                if (senhaPick !== SENHA_PICKALL) {
                    delete pickallPendente[jid];
                    return sock.sendMessage(jid, { text: '❌ Senha incorreta! Operação cancelada.' }, { quoted: m });
                }

                if (!pickallPendente[jid]) {
                    return sock.sendMessage(jid, { text: '⚠️ Você precisa solicitar primeiro com *.pickall* (sem senha).' }, { quoted: m });
                }

                if (Date.now() - pickallPendente[jid].timestamp > 60 * 1000) {
                    delete pickallPendente[jid];
                    return sock.sendMessage(jid, { text: '⏰ Tempo de confirmação expirado. Solicite novamente com *.pickall*.' }, { quoted: m });
                }

                delete pickallPendente[jid];
                await sock.sendMessage(jid, { text: '🧹 *PICKALL INICIADO!*\n\nRemovendo todos os membros...' });

                try {
                    const metaPickall = await sock.groupMetadata(jid);
                    const botJid = jidNormalizedUser(sock.user.id);
                    const removerLista = metaPickall.participants
                        .map(p => p.id)
                        .filter(id => id !== sender && id !== botJid && id !== DONO_SUPREMO && id !== DONO_ADMIN);

                    let removidos = 0;
                    let falhas = 0;
                    for (const pid of removerLista) {
                        try {
                            await sock.groupParticipantsUpdate(jid, [pid], 'remove');
                            removidos++;
                        } catch {
                            falhas++;
                        }
                        await new Promise(r => setTimeout(r, 1500));
                    }
                    await sock.sendMessage(jid, { text: `✅ *PICKALL CONCLUÍDO!*\n\n➥ Removidos: ${removidos}\n➥ Falhas: ${falhas}` });
                } catch (err) {
                    await sock.sendMessage(jid, { text: `❌ Erro no pickall: ${err.message}` });
                }
                break;
            }

case 'brat': {
                try {
                    const textoBrat = args.join(' ').trim();
                    if (!textoBrat) {
                        return sock.sendMessage(jid, {
                            text: '❌ Escreva algo!\n\nExemplo: *.brat olá mundo*'
                        }, { quoted: m });
                    }

                    // reage "aguardando"
                    await sock.sendMessage(jid, { react: { text: '⏳', key: m.key } });

                    // Gera a imagem brat (fundo branco + texto) via API pública
                    const urlBrat = `https://api.siputzx.my.id/api/m/brat?text=${encodeURIComponent(textoBrat)}`;
                    const respBrat = await axios.get(urlBrat, {
                        responseType: 'arraybuffer',
                        timeout: 20000,
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });

                    const bufferBrat = Buffer.from(respBrat.data, 'binary');

                    // Cria a figurinha
                    const stickerBrat = new Sticker(bufferBrat, {
                        pack: 'Atrino Bot',
                        author: 'Garibaldo356',
                        type: StickerTypes.FULL,
                        quality: 70
                    });

                    await sock.sendMessage(jid, await stickerBrat.toMessage());
                    await sock.sendMessage(jid, { react: { text: '✅', key: m.key } });
                } catch (errBrat) {
                    console.error('[brat] erro:', errBrat.message);
                    await sock.sendMessage(jid, {
                        text: '❌ Erro ao gerar figurinha brat. Tente novamente.'
                    }, { quoted: m });
                    await sock.sendMessage(jid, { react: { text: '❌', key: m.key } });
                }
                break;
            }
            
            case 'apagar': {
                if (!isSenderAdmin) return;
                const alvoApagar = getMention() || m.message.extendedTextMessage?.contextInfo?.participant;
                if (!alvoApagar) {
                    return sock.sendMessage(jid, { text: '❌ Mencione o usuário ou responda a uma mensagem dele!\n\nExemplo: *.apagar @usuario*' }, { quoted: m });
                }

                let alvoEhAdminApagar = false;
                try {
                    const metaApagar = await sock.groupMetadata(jid);
                    alvoEhAdminApagar = metaApagar.participants.filter(p => p.admin).map(p => p.id).includes(alvoApagar);
                } catch {}
                if (alvoEhAdminApagar || alvoApagar === DONO_SUPREMO || alvoApagar === DONO_ADMIN) {
                    return sock.sendMessage(jid, { text: '❌ Não é possível apagar mensagens de um administrador.' }, { quoted: m });
                }

                const msgsAlvo = mensagensRastreadas[jid]?.[alvoApagar] || [];
                if (!msgsAlvo.length) {
                    return sock.sendMessage(jid, {
                        text: `⚠️ Nenhuma mensagem rastreada de @${alvoApagar.split('@')[0]} desde que o bot está online.`,
                        mentions: [alvoApagar]
                    }, { quoted: m });
                }

                await sock.sendMessage(jid, {
                    text: `🧹 *APAGAR — VARREDURA*\n\nIniciando remoção de ${msgsAlvo.length} mensagens de @${alvoApagar.split('@')[0]}...`,
                    mentions: [alvoApagar]
                }, { quoted: m });

                let apagadas = 0;
                let falhasApagar = 0;
                const paraApagar = [...msgsAlvo];
                mensagensRastreadas[jid][alvoApagar] = [];

                for (const item of paraApagar) {
                    try {
                        await sock.sendMessage(jid, { delete: item.key });
                        apagadas++;
                    } catch {
                        falhasApagar++;
                    }
                    await new Promise(r => setTimeout(r, 150));
                }

                await sock.sendMessage(jid, {
                    text: `✅ *VARREDURA CONCLUÍDA!*\n\n👤 @${alvoApagar.split('@')[0]}\n🗑️ Apagadas: ${apagadas}\n⚠️ Falhas: ${falhasApagar}`,
                    mentions: [alvoApagar]
                }, { quoted: m });
                break;
            }

            case 'registrar_grupo_triagem': {
                if (!isSenderAdmin) return;
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Use este comando dentro do grupo que receberá as triagens.' }, { quoted: m });
                const codigo = args[0]?.trim();
                if (!codigo || !/^\d{1,12}$/.test(codigo)) {
                    return sock.sendMessage(jid, { text: '❌ Uso: *.registrar_grupo_triagem <código>*\nExemplo: *.registrar_grupo_triagem 555*' }, { quoted: m });
                }
                if (gruposTriagemPorCodigo[codigo] && gruposTriagemPorCodigo[codigo] !== jid) {
                    return sock.sendMessage(jid, { text: `❌ O código ${codigo} já está vinculado a outro grupo.` }, { quoted: m });
                }
                const grupoAnterior = gruposTriagemPorCodigo[codigo];
                const ativoAnterior = triagensAtivasPorCodigo[codigo];
                const estadoAnterior = obterEstadoTriagem(jid).ativa;
                gruposTriagemPorCodigo[codigo] = jid;
                triagensAtivasPorCodigo[codigo] = true;
                obterEstadoTriagem(jid).ativa = true;
                if (!await syncEstadoBotToGithub()) {
                    if (grupoAnterior) {
                        gruposTriagemPorCodigo[codigo] = grupoAnterior;
                        triagensAtivasPorCodigo[codigo] = ativoAnterior !== false;
                        obterEstadoTriagem(grupoAnterior).ativa = triagensAtivasPorCodigo[codigo];
                    } else {
                        delete gruposTriagemPorCodigo[codigo];
                        delete triagensAtivasPorCodigo[codigo];
                        obterEstadoTriagem(jid).ativa = estadoAnterior;
                    }
                    return sock.sendMessage(jid, { text: '❌ Não foi possível salvar no GitHub. Confira GITHUB_TOKEN e permissão Contents: Read and write.' }, { quoted: m });
                }
                await sock.sendMessage(jid, { text: `✅ Grupo cadastrado e ativado!\n\nCódigo: *${codigo}*\nNo privado, use *.triagem${codigo}*.` }, { quoted: m });
                break;
            }

            case 'ativar_triagem': {
                if (!isSenderAdmin) return;
                const estado = estadosTriagem[jid];
                if (estado) {
                    estado.ativa = true;
                    for (const [codigo, grupoJid] of Object.entries(gruposTriagemPorCodigo)) {
                        if (grupoJid === jid) triagensAtivasPorCodigo[codigo] = true;
                    }
                    estado.finalizadas.clear();
                    estado.filaPendente.length = 0;
                    estado.filaEmAnalise = null;
                    estado.contadorTicket = 0;
                } else {
                    grupoTriagemAtivo = jid;
                    triagensFinalizadas.clear();
                    filaPendente.length = 0;
                    filaEmAnalise = null;
                    contadorTicket = 0;
                }
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: estado ? '✅ Triagem ativada! Use *.triagem<CÓDIGO>* no privado.' : '✅ Triagem ativada! Membros podem enviar *.triagem* no privado.' }, { quoted: m });
                break;
            }

            case 'desativar_triagem': {
                if (!isSenderAdmin) return;
                const estado = estadosTriagem[jid];
                if (estado) {
                    if (!estado.ativa) return sock.sendMessage(jid, { text: '⚠️ Triagem não está ativa aqui.' }, { quoted: m });
                    estado.ativa = false;
                    estado.responsavel = null;
                    for (const [codigo, grupoJid] of Object.entries(gruposTriagemPorCodigo)) {
                        if (grupoJid === jid) triagensAtivasPorCodigo[codigo] = false;
                    }
                } else {
                    if (grupoTriagemAtivo !== jid) return sock.sendMessage(jid, { text: '⚠️ Triagem não está ativa aqui.' }, { quoted: m });
                    grupoTriagemAtivo = null;
                    sessaoTriagemResponsavel = null;
                }
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: '🔒 Triagem desativada.' }, { quoted: m });
                break;
            }

            case 'ativar_fila': {
                if (!isSenderAdmin) return;
                const estado = estadosTriagem[jid];
                if (estado) {
                    estado.filaAtiva = true;
                    estado.filaPendente.length = 0;
                    estado.filaEmAnalise = null;
                    estado.contadorTicket = 0;
                } else {
                    filaAtiva = true;
                    filaPendente.length = 0;
                    filaEmAnalise = null;
                    contadorTicket = 0;
                }
                await sock.sendMessage(jid, { text: '🔢 *FILA SEQUENCIAL ATIVADA!*\n\nAs triagens serão enviadas 1 por vez.\nUse *.aprovar* ou *.reprovar* para avançar.' }, { quoted: m });
                break;
            }

            case 'desativar_fila': {
                if (!isSenderAdmin) return;
                const estado = estadosTriagem[jid];
                if (estado) {
                    estado.filaAtiva = false;
                    estado.filaPendente.length = 0;
                    estado.filaEmAnalise = null;
                } else {
                    filaAtiva = false;
                    filaPendente.length = 0;
                    filaEmAnalise = null;
                }
                await sock.sendMessage(jid, { text: '🔕 Fila desativada.' }, { quoted: m });
                break;
            }

            case 'registrar_link': {
                if (!isSenderAdmin) return;
                if (!args[0]) return sock.sendMessage(jid, { text: '❌ Uso: *.registrar_link https://chat.whatsapp.com/...' }, { quoted: m });
                const estado = estadosTriagem[jid];
                const link = args[0].trim();
                if (estado) estado.linkGrupo = link;
                else linkGrupoTriagem = link;
                await sock.sendMessage(jid, { text: `✅ Link registrado:\n🔗 ${link}` }, { quoted: m });
                break;
            }

            case 'registrar_adm': {
                if (!isSenderAdmin) return;
                const alvoCadastro = getMention();
                const apelidoCadastro = args[1] || args[0];
                const senhaCadastro   = args[2] || args[1];

                if (!alvoCadastro || !apelidoCadastro || !senhaCadastro) {
                    return sock.sendMessage(jid, { text: '❌ Uso: *.registrar_adm @pessoa apelido senha*\nExemplo: .registrar_adm @João João123 minhasenha' }, { quoted: m });
                }

                adminsTriagem[alvoCadastro] = {
                    apelido: apelidoCadastro,
                    senhaHash: hashSenha(senhaCadastro),
                    loginAtivo: false,
                    horarioMarcado: null,
                    aprovacoes: 0,
                    reprovacoes: 0
                };

                await sock.sendMessage(jid, {
                    text: `✅ *ADM DE TRIAGEM CADASTRADO!*\n\n👤 @${alvoCadastro.split('@')[0]}\n🏷️ Apelido: *${apelidoCadastro}*\n🔑 Senha registrada com sucesso.\n\nPara entrar de plantão: *.login_triagem <senha>*`,
                    mentions: [alvoCadastro]
                }, { quoted: m });
                break;
            }

            case 'login_triagem': {
                const senhaLogin = args[0];
                if (!senhaLogin) return sock.sendMessage(jid, { text: '❌ Uso: *.login_triagem <sua_senha>*' }, { quoted: m });

                const admEncontrado = Object.entries(adminsTriagem).find(
                    ([admJid, dados]) => admJid === sender && dados.senhaHash === hashSenha(senhaLogin)
                );

                if (!admEncontrado) {
                    return sock.sendMessage(jid, { text: '❌ Senha incorreta ou você não está cadastrado como ADM de triagem.' }, { quoted: m });
                }

                const [admJid, admDados] = admEncontrado;
                const slots = gerarHorariosDisponiveis();
                admDados.loginAtivo = true;
                admDados._grupoTriagemJid = isGroup ? jid : grupoTriagemAtivo;

                await sock.sendMessage(jid, {
                    text: `✅ *Login realizado!*\n\n👋 Olá, *${admDados.apelido}*!\n🕐 Horário de início: *${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}*\n\n📅 *Marque seu horário de plantão:*\n\n${slots.map((h, i) => `${i + 1}️⃣ ${h}`).join('\n')}\n\nResponda com o número da opção (1 a ${slots.length}) para marcar.`,
                    _slots: slots
                }, { quoted: m });

                admDados._slotsDisponiveis = slots;
                admDados._aguardandoEscolha = true;
                break;
            }

            case 'aprovar': {
                if (!isSenderAdmin) return;
                const estado = estadosTriagem[jid] || null;
                const filaPendenteAtual = estado ? estado.filaPendente : filaPendente;
                const responsavelAtual = estado ? estado.responsavel : sessaoTriagemResponsavel;

                if (responsavelAtual && sender !== responsavelAtual &&
                    sender !== DONO_SUPREMO && sender !== DONO_ADMIN) {
                    const respApelido = adminsTriagem[responsavelAtual]?.apelido || 'outro adm';
                    return sock.sendMessage(jid, { text: `❌ Apenas *${respApelido}* (responsável de plantão) pode aprovar/reprovar agora.` }, { quoted: m });
                }

                const ticketAprovar = parseInt(args[0]);
                if (isNaN(ticketAprovar)) return sock.sendMessage(jid, { text: '❌ Uso: *.aprovar <número>*' }, { quoted: m });
                const entradaEmAnalise = estado ? estado.filaEmAnalise : filaEmAnalise;
                if (!entradaEmAnalise || entradaEmAnalise.ticket !== ticketAprovar) {
                    return sock.sendMessage(jid, { text: `❌ Ticket #${ticketAprovar} não está em análise no momento.` }, { quoted: m });
                }

                const entrada = entradaEmAnalise;
                entrada.status = 'aprovado';
                try { analiseDiaria.registrarEvento('triagemAprovada', jid); }
                catch (erroRegistro) { console.error('[documento] falha ao salvar triagem aprovada:', erroRegistro.message); }
                if (estado) estado.filaEmAnalise = null;
                else filaEmAnalise = null;

                if (adminsTriagem[sender]) adminsTriagem[sender].aprovacoes++;

                await sock.sendMessage(jid, { text: `✅ Ticket #${ticketAprovar} *APROVADO!*\n📱 ${entrada.numeroExibir}` }, { quoted: m });

                try {
                    const responsavelApelido = responsavelAtual && adminsTriagem[responsavelAtual]
                        ? adminsTriagem[responsavelAtual].apelido : 'Equipe';
                    let msgAprov = `🎉 *SUA TRIAGEM FOI APROVADA!*\n\n✅ Ticket: *#${ticketAprovar}*\n📱 Número: ${entrada.numeroExibir}\n👔 Responsável: *${responsavelApelido}*\n\nParabéns!`;
                    const linkGrupoAtual = estado ? estado.linkGrupo : linkGrupoTriagem;
                    if (linkGrupoAtual) msgAprov += `\n\n🔗 *Entre no grupo agora:*\n${linkGrupoAtual}`;
                    await sock.sendMessage(entrada.senderJid, { text: msgAprov });
                    setTimeout(async () => { try { await sock.chatModify({ clear: { before: new Date() } }, entrada.senderJid); } catch {} }, 3 * 60 * 1000);
                } catch {}

                for (let i = 0; i < filaPendenteAtual.length; i++) {
                    try { await sock.sendMessage(filaPendenteAtual[i].senderJid, { text: `📊 *ATUALIZAÇÃO*\n\nTicket #${filaPendenteAtual[i].ticket} — Posição: *${i + 2}º*\n⏳ Aguarde.` }); } catch {}
                }

                if (adminsTriagem[sender]) {
                    const total = adminsTriagem[sender].aprovacoes + adminsTriagem[sender].reprovacoes;
                    const metaAtual = estado ? estado.metaTriagens : metaTriagens;
                    if (total === metaAtual) {
                        await sock.sendMessage(jid, { text: `🏆 *META BATIDA!*\n\n👔 ${adminsTriagem[sender].apelido} atingiu *${metaAtual} triagens* processadas!` });
                    }
                }

                await enviarProximaTriagemAoGrupo(sock, estado);
                break;
            }

            case 'reprovar': {
                if (!isSenderAdmin) return;
                const estado = estadosTriagem[jid] || null;
                const filaPendenteAtual = estado ? estado.filaPendente : filaPendente;
                const responsavelAtual = estado ? estado.responsavel : sessaoTriagemResponsavel;

                if (responsavelAtual && sender !== responsavelAtual &&
                    sender !== DONO_SUPREMO && sender !== DONO_ADMIN) {
                    const respApelido = adminsTriagem[responsavelAtual]?.apelido || 'outro adm';
                    return sock.sendMessage(jid, { text: `❌ Apenas *${respApelido}* pode reprovar agora.` }, { quoted: m });
                }

                const ticketReprovar = parseInt(args[0]);
                if (isNaN(ticketReprovar)) return sock.sendMessage(jid, { text: '❌ Uso: *.reprovar <número>*' }, { quoted: m });
                const entradaEmAnalise = estado ? estado.filaEmAnalise : filaEmAnalise;
                if (!entradaEmAnalise || entradaEmAnalise.ticket !== ticketReprovar) {
                    return sock.sendMessage(jid, { text: `❌ Ticket #${ticketReprovar} não está em análise no momento.` }, { quoted: m });
                }

                const entrada = entradaEmAnalise;
                entrada.status = 'reprovado';
                try { analiseDiaria.registrarEvento('triagemReprovada', jid); }
                catch (erroRegistro) { console.error('[documento] falha ao salvar triagem reprovada:', erroRegistro.message); }
                if (estado) estado.filaEmAnalise = null;
                else filaEmAnalise = null;

                if (adminsTriagem[sender]) adminsTriagem[sender].reprovacoes++;

                await sock.sendMessage(jid, { text: `❌ Ticket #${ticketReprovar} *REPROVADO*.\n📱 ${entrada.numeroExibir}` }, { quoted: m });

                try {
                    const responsavelApelido = responsavelAtual && adminsTriagem[responsavelAtual]
                        ? adminsTriagem[responsavelAtual].apelido : 'Equipe';
                    await sock.sendMessage(entrada.senderJid, {
                        text: `❌ *SUA TRIAGEM FOI REPROVADA*\n\nTicket: *#${ticketReprovar}*\n📱 ${entrada.numeroExibir}\n👔 Responsável: *${responsavelApelido}*\n\nInfelizmente não foi aprovado desta vez.`
                    });
                    setTimeout(async () => { try { await sock.chatModify({ clear: { before: new Date() } }, entrada.senderJid); } catch {} }, 3 * 60 * 1000);
                } catch {}

                for (let i = 0; i < filaPendenteAtual.length; i++) {
                    try { await sock.sendMessage(filaPendenteAtual[i].senderJid, { text: `📊 *ATUALIZAÇÃO*\n\nTicket #${filaPendenteAtual[i].ticket} — Posição: *${i + 2}º*\n⏳ Aguarde.` }); } catch {}
                }

                if (adminsTriagem[sender]) {
                    const total = adminsTriagem[sender].aprovacoes + adminsTriagem[sender].reprovacoes;
                    const metaAtual = estado ? estado.metaTriagens : metaTriagens;
                    if (total === metaAtual) {
                        await sock.sendMessage(jid, { text: `🏆 *META BATIDA!*\n\n👔 ${adminsTriagem[sender].apelido} atingiu *${metaAtual} triagens* processadas!` });
                    }
                }

                await enviarProximaTriagemAoGrupo(sock, estado);
                break;
            }

            case 'metas': {
                if (!isSenderAdmin) return;
                const estado = estadosTriagem[jid] || null;
                const metaAtual = estado ? estado.metaTriagens : metaTriagens;
                const responsavelAtual = estado ? estado.responsavel : sessaoTriagemResponsavel;
                const filaEmAnaliseAtual = estado ? estado.filaEmAnalise : filaEmAnalise;
                const filaPendenteAtual = estado ? estado.filaPendente : filaPendente;
                const admLista = Object.entries(adminsTriagem);
                if (!admLista.length) return sock.sendMessage(jid, { text: '❌ Nenhum adm de triagem cadastrado ainda.' }, { quoted: m });

                let painelMetas = `📊 *PAINEL DE METAS — TRIAGENS*\n🎯 Meta atual: *${metaAtual} triagens*\n━━━━━━━━━━━━━━━━\n\n`;
                for (const [admJid, dados] of admLista) {
                    const total = dados.aprovacoes + dados.reprovacoes;
                    const pct   = metaAtual > 0 ? Math.min(100, Math.round((total / metaAtual) * 100)) : 0;
                    const barra = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
                    const plantao = responsavelAtual === admJid ? ' 🟢 *PLANTÃO*' : '';
                    painelMetas += `👔 *${dados.apelido}*${plantao}\n`;
                    painelMetas += `   ✅ Aprovadas: ${dados.aprovacoes} | ❌ Reprovadas: ${dados.reprovacoes}\n`;
                    painelMetas += `   📈 Total: ${total}/${metaAtual} (${pct}%)\n`;
                    painelMetas += `   [${barra}]\n\n`;
                }
                if (filaEmAnaliseAtual) painelMetas += `\n🔍 Em análise: Ticket #${filaEmAnaliseAtual.ticket}`;
                painelMetas += `\n📥 Na fila: ${filaPendenteAtual.length} triagem(ns)`;
                await sock.sendMessage(jid, { text: painelMetas }, { quoted: m });
                break;
            }

            case 'alterar_meta': {
                if (!isSenderAdmin) return;
                const novaMeta = parseInt(args[0]);
                if (isNaN(novaMeta) || novaMeta < 1) return sock.sendMessage(jid, { text: '❌ Uso: *.alterar_meta <número>*\nExemplo: .alterar_meta 20' }, { quoted: m });
                const estado = estadosTriagem[jid];
                if (estado) estado.metaTriagens = novaMeta;
                else metaTriagens = novaMeta;
                await sock.sendMessage(jid, { text: `✅ Meta alterada para *${novaMeta} triagens* por sessão.` }, { quoted: m });
                break;
            }

            case 'alert_tiktok': {
                if (!isSenderAdmin) return;
                const inputTk = args[0];
                if (!inputTk) return sock.sendMessage(jid, { text: '❌ Uso: *.alert_tiktok @nomeusuario*' }, { quoted: m });
                const usernameTk = inputTk.replace(/^@/, '').trim();
                await sock.sendMessage(jid, { text: `⏳ Verificando @${usernameTk}...` }, { quoted: m });
                try {
                    const videoInicial = await buscarUltimoVideoTikTok(usernameTk);
                    alertasTikTok[jid] = { username: usernameTk, ultimoVideoId: videoInicial.id };
                    await sock.sendMessage(jid, { text: `✅ *Alerta TikTok ativado!*\n👤 @${usernameTk}\n📹 Último: ${videoInicial.titulo}\n⏱      Verifica a cada 5min.\n\nPara remover: *.remover_alert_tiktok*` }, { quoted: m });
                } catch (tkErr) {
                    await sock.sendMessage(jid, { text: `❌ Não foi possível acessar @${usernameTk}. Verifique o @ e tente novamente.` }, { quoted: m });
                }
                break;
            }

            case 'remover_alert_tiktok':
                if (!isSenderAdmin) return;
                if (!alertasTikTok[jid]) return sock.sendMessage(jid, { text: '⚠️ Nenhum alerta TikTok ativo.' }, { quoted: m });
                const usernameRem = alertasTikTok[jid].username;
                delete alertasTikTok[jid];
                await sock.sendMessage(jid, { text: `🔕 Alerta de *@${usernameRem}* removido.` }, { quoted: m });
                break;

             case 'registrar': {
                if (gruposRegistrados.includes(jid)) return sock.sendMessage(jid, { text: '✅ Grupo já registrado!' }, { quoted: m });

                const senhaDigitada = args[0];

                // Caso 1: veio com senha E ela bate → REGISTRA
                if (senhaDigitada && senhaRegistro && senhaDigitada === senhaRegistro) {
                    await sock.sendMessage(jid, { text: '⏳ Registrando...' }, { quoted: m });
                    gruposRegistrados.push(jid);
                    const sincronizado = await syncEstadoBotToGithub();
                    if (!sincronizado) {
                        gruposRegistrados = gruposRegistrados.filter(id => id !== jid);
                        return sock.sendMessage(jid, {
                            text: '❌ Não foi possível salvar o registro no GitHub. O grupo não foi registrado. Verifique a variável GITHUB_TOKEN e a permissão Contents: Read and write no repositório Jackreality2/servidor.'
                        }, { quoted: m });
                    }
                    senhaRegistro = null;
                    return sock.sendMessage(jid, { text: '🚀 *GRUPO REGISTRADO!*' }, { quoted: m });
                }

                // Caso 2: senha incorreta
                if (senhaDigitada) {
                    return sock.sendMessage(jid, {
                        text: `❌ *Senha incorreta!*\n\nPeça ao dono a senha atual e tente novamente:\n\n*.registrar <senha>*\n\n🔗 Painel: https://servidor-72g6.onrender.com/`
                    }, { quoted: m });
                }

                // Caso 3: sem senha → gera nova, mostra no log E por mensagem
                senhaRegistro = Math.random().toString(36).substring(2, 8).toUpperCase();
                const dataLog = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

                // Log do console
                console.log('\n');
                console.log('╔══════════════════════════════════════════╗');
                console.log('║   🔑 SOLICITAÇÃO DE REGISTRO DE GRUPO    ║');
                console.log('╠══════════════════════════════════════════╣');
                console.log(`║  📅 Data: ${dataLog}`);
                console.log(`║  👤 Solicitante: ${sender.split('@')[0]}`);
                console.log(`║  🏠 Grupo JID: ${jid}`);
                console.log(`║  🔑 SENHA GERADA: ${senhaRegistro}`);
                console.log(`║  📝 Comando a usar: .registrar ${senhaRegistro}`);
                console.log('╚══════════════════════════════════════════╝');
                console.log('\n');

                // Mensagem no grupo (mostra a senha)
                return sock.sendMessage(jid, {
                    text: `🔑 *SENHA DE REGISTRO GERADA!*\n\n📋 *Senha:* ${senhaRegistro}\n\n✅ Use o comando abaixo para registrar:\n\n*.registrar ${senhaRegistro}*\n\n🔗 Painel: https://servidor-72g6.onrender.com/`
                }, { quoted: m });
            }

            case 'desativa_bot':
                if (!isSenderAdmin) return;
                if (!senhaRegistro || args[0] !== senhaRegistro) {
                    // mostra a senha atual por mensagem junto do erro
                    const senhaMsg = senhaRegistro || '(nenuma senha ativa)';
                    return sock.sendMessage(jid, {
                        text: `⚠️ *Senha inválida!*\n\n🔑 Senha atual: *${senhaMsg}*\n\nUse: *.desativa_bot ${senhaRegistro || '<senha>'}*\n\n🔗 https://servidor-72g6.onrender.com/`
                    }, { quoted: m });
                }
                await sock.sendMessage(jid, { text: `╭─── [ ⚠️ *BOT DESATIVADO* ] ───╮\n│ O bot sairá em 5 minutos.\n╰─────��───────────────╯` });
                gruposRegistrados = gruposRegistrados.filter(id => id !== jid);
                if (grupoTriagemAtivo === jid) grupoTriagemAtivo = null;
                await syncEstadoBotToGithub();
                senhaRegistro = null;
                setTimeout(async () => { try { await sock.sendMessage(jid, { text: '👋 Saindo...' }); await sock.groupLeave(jid); } catch {} }, 300000);
                break;

            case 'tornaadm': {
                if (!isSenderAdmin) return;
                const userToAdmin = getMention();
                if (!userToAdmin) return sock.sendMessage(jid, { text: '❌ Mencione alguém!' });
                await sock.groupParticipantsUpdate(jid, [userToAdmin], 'promote');
                await sock.sendMessage(jid, { text: `✅ @${userToAdmin.split('@')[0]} agora é Admin!`, mentions: [userToAdmin] });
                break;
            }

            case 'rebaixar': {
                if (!isSenderAdmin) return;
                const userRebaixar = getMention();
                if (!userRebaixar) return sock.sendMessage(jid, { text: '❌ Mencione o admin!' }, { quoted: m });
                try {
                    const metaR = await sock.groupMetadata(jid);
                    if (!metaR.participants.filter(p => p.admin).map(p => p.id).includes(userRebaixar))
                        return sock.sendMessage(jid, { text: `⚠️ @${userRebaixar.split('@')[0]} não é admin.`, mentions: [userRebaixar] }, { quoted: m });
                    await sock.groupParticipantsUpdate(jid, [userRebaixar], 'demote');
                    await sock.sendMessage(jid, { text: `🔻 @${userRebaixar.split('@')[0]} rebaixado.`, mentions: [userRebaixar] }, { quoted: m });
                } catch { await sock.sendMessage(jid, { text: '❌ Erro ao rebaixar.' }, { quoted: m }); }
                break;
            }

            case 'adv': {
                if (!isSenderAdmin) return;
                const uAdv = getMention();
                if (!uAdv) return sock.sendMessage(jid, { text: '❌ Mencione o usuário!' }, { quoted: m });
                try {
                    const metaA = await sock.groupMetadata(jid);
                    if (metaA.participants.filter(p => p.admin).map(p => p.id).includes(uAdv))
                        return sock.sendMessage(jid, { text: '❌ Não é possível advertir um administrador.' }, { quoted: m });
                } catch {}
                advertencias[uAdv] = (advertencias[uAdv] || 0) + 1;
                if (advertencias[uAdv] >= 3) {
                    await sock.sendMessage(jid, { text: `🚫 @${uAdv.split('@')[0]} atingiu 3/3 e foi removido.`, mentions: [uAdv] });
                    await sock.groupParticipantsUpdate(jid, [uAdv], 'remove');
                    delete advertencias[uAdv];
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ Adv ${advertencias[uAdv]}/3 para @${uAdv.split('@')[0]}`, mentions: [uAdv] });
                }
                break;
            }

            case 'unadv': {
                if (!isSenderAdmin) return;
                const userUnadv = getMention();
                if (!userUnadv) return sock.sendMessage(jid, { text: '❌ Mencione o usuário!' }, { quoted: m });
                if (!advertencias[userUnadv] || advertencias[userUnadv] <= 0)
                    return sock.sendMessage(jid, { text: `⚠️ @${userUnadv.split('@')[0]} não possui advertências.`, mentions: [userUnadv] }, { quoted: m });
                advertencias[userUnadv]--;
                if (advertencias[userUnadv] === 0) delete advertencias[userUnadv];
                await sock.sendMessage(jid, { text: `✅ Adv removida de @${userUnadv.split('@')[0]}. Restantes: ${advertencias[userUnadv] || 0}/3`, mentions: [userUnadv] }, { quoted: m });
                break;
            }

            case 'mute': {
                if (!isSenderAdmin) return;
                const userMute = getMention();
                if (!userMute) return;
                if (!mutados.includes(userMute)) mutados.push(userMute);
                await sock.sendMessage(jid, { text: `🤫 @${userMute.split('@')[0]} silenciado.`, mentions: [userMute] });
                break;
            }
            case 'mutar': {
                if (!isGroup) return;
                const alvoMute = getMention();
                if (!alvoMute) return sock.sendMessage(jid, { text: '❌ Mencione a pessoa que deseja mutar. Exemplo: *.mutar @nome*' }, { quoted: m });
                if (alvoMute === sender) return sock.sendMessage(jid, { text: '❌ Você não pode se mutar.' }, { quoted: m });
                const chaveMute = `${jid}|${alvoMute}`;
                const muteAtivo = mutesTemporarios[chaveMute];
                if (muteAtivo && muteAtivo.expiraEm > Date.now()) {
                    return sock.sendMessage(jid, { text: '⚠️ Essa pessoa já está mutada temporariamente.' }, { quoted: m });
                }

                const pontosDisponiveis = pontosSorteio[jid]?.[sender] || 0;
                if (pontosDisponiveis < PONTOS_POR_MUTAR) {
                    return sock.sendMessage(jid, { text: `❌ Você precisa de ${PONTOS_POR_MUTAR} ponto para usar .mutar. Use *.ranking* para consultar seus pontos.` }, { quoted: m });
                }

                const metaGrupo = await sock.groupMetadata(jid);
                const alvoNoGrupo = metaGrupo.participants.some((participante) => participante.id === alvoMute);
                if (!alvoNoGrupo) return sock.sendMessage(jid, { text: '❌ Essa pessoa não está neste grupo.' }, { quoted: m });

                pontosSorteio[jid][sender] = pontosDisponiveis - PONTOS_POR_MUTAR;
                if (pontosSorteio[jid][sender] <= 0) delete pontosSorteio[jid][sender];
                await syncEstadoBotToGithub();

                const muteNovo = { expiraEm: Date.now() + 60 * 1000, timer: null };
                muteNovo.timer = setTimeout(async () => {
                    if (mutesTemporarios[chaveMute] !== muteNovo) return;
                    delete mutesTemporarios[chaveMute];
                    try {
                        await sock.sendMessage(jid, {
                            text: `🔊 @${alvoMute.split('@')[0]} foi desmutado e já pode voltar a falar.`,
                            mentions: [alvoMute]
                        });
                    } catch (errDesmute) {
                        console.error('[mutar] erro ao anunciar desmute:', errDesmute.message);
                    }
                }, 60 * 1000);
                mutesTemporarios[chaveMute] = muteNovo;
                await sock.sendMessage(jid, {
                    text: `🔇 @${alvoMute.split('@')[0]} foi mutado por @${sender.split('@')[0]} por 1 minuto. ${PONTOS_POR_MUTAR} ponto foi usado.`,
                    mentions: [alvoMute, sender]
                }, { quoted: m });
                break;
            }
            case 'roubar': {
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ O comando *.roubar* só pode ser usado em grupos.' }, { quoted: m });
                const alvoRoubar = getMention();
                if (!alvoRoubar) {
                    return sock.sendMessage(jid, { text: '❌ Mencione quem você quer tentar roubar.\nExemplo: *.roubar @pessoa*' }, { quoted: m });
                }
                if (alvoRoubar === sender) {
                    return sock.sendMessage(jid, { text: '❌ Você não pode roubar seus próprios pontos.' }, { quoted: m });
                }

                const metaRoubo = await sock.groupMetadata(jid);
                const alvoNoGrupoRoubo = metaRoubo.participants.some((participante) => participante.id === alvoRoubar);
                if (!alvoNoGrupoRoubo) {
                    return sock.sendMessage(jid, { text: '❌ Essa pessoa não está neste grupo.' }, { quoted: m });
                }

                const pontosAlvoRoubo = Number(pontosSorteio[jid]?.[alvoRoubar]) || 0;
                if (pontosAlvoRoubo < 1) {
                    return sock.sendMessage(jid, { text: '❌ Essa pessoa não tem pontos disponíveis para roubar.' }, { quoted: m });
                }

                if (Math.random() >= 0.5) {
                    return sock.sendMessage(jid, {
                        text: `🕵️ @${sender.split('@')[0]} tentou roubar um ponto de @${alvoRoubar.split('@')[0]}, mas falhou!`,
                        mentions: [sender, alvoRoubar]
                    }, { quoted: m });
                }

                if (!pontosSorteio[jid]) pontosSorteio[jid] = {};
                const pontosLadraoAntes = Number(pontosSorteio[jid][sender]) || 0;
                pontosSorteio[jid][alvoRoubar] = pontosAlvoRoubo - 1;
                if (pontosSorteio[jid][alvoRoubar] <= 0) delete pontosSorteio[jid][alvoRoubar];
                pontosSorteio[jid][sender] = pontosLadraoAntes + 1;

                if (!await syncEstadoBotToGithub()) {
                    pontosSorteio[jid][alvoRoubar] = pontosAlvoRoubo;
                    pontosSorteio[jid][sender] = pontosLadraoAntes;
                    if (pontosSorteio[jid][sender] <= 0) delete pontosSorteio[jid][sender];
                    return sock.sendMessage(jid, { text: '❌ Não consegui salvar a transferência. Nenhum ponto foi transferido.' }, { quoted: m });
                }

                await sock.sendMessage(jid, {
                    text: `🦹 @${sender.split('@')[0]} conseguiu roubar 1 ponto de @${alvoRoubar.split('@')[0]}!\n\n⭐ Saldo atual: ${pontosSorteio[jid][sender]} ponto(s).`,
                    mentions: [sender, alvoRoubar]
                }, { quoted: m });
                break;
            }
            case 'desmute': {
                if (!isSenderAdmin) return;
                const userDesmute = getMention();
                mutados = mutados.filter(x => x !== userDesmute);
                await sock.sendMessage(jid, { text: '🔊 Liberado.', mentions: [userDesmute] });
                break;
            }
            case 'ban': {
                if (!isSenderAdmin) return;
                const userBan = getMention();
                if (!userBan) return sock.sendMessage(jid, { text: '❌ Mencione alguém!' });
                const motivoBan = args.join(' ').replace(/@\d+/g, '').trim() || 'Sem motivo';
                await sock.sendMessage(jid, { text: `🚫 @${userBan.split('@')[0]} removido.\n📝 Motivo: ${motivoBan}`, mentions: [userBan] });
                await sock.groupParticipantsUpdate(jid, [userBan], 'remove');
                break;
            }
            case 'totag': {
                if (!isSenderAdmin) return;
                const metaTotag = await sock.groupMetadata(jid);
                let textT = `📢 *AVISO GERAL*\n\n${args.join(' ') || 'Atenção!'}\n\n`;
                for (const mem of metaTotag.participants) textT += `➥ @${mem.id.split('@')[0]}\n`;
                if (textT.length > 3800) textT = textT.substring(0, 3800) + '\n⚠️ Lista encurtada.';
                await sock.sendMessage(jid, { text: textT, mentions: metaTotag.participants.map(p => p.id) });
                break;
            }
            case 'abrir':
                if (!isSenderAdmin) return;
                try {
                    await sock.groupSettingUpdate(jid, 'not_announcement');
                    await enviarAvisoAberturaFechamento(sock, jid, 'abertura');
                } catch (errAbrir) {
                    console.error('[abrir] erro:', errAbrir.message);
                    await sock.sendMessage(jid, { text: '❌ Não consegui abrir o grupo. Confira se o bot é administrador.' });
                }
                break;
            case 'so_adm':
                if (!isSenderAdmin) return;
                apenasAdmAtivo[jid] = !apenasAdmAtivo[jid];
                await sock.sendMessage(jid, {
                    text: apenasAdmAtivo[jid]
                        ? '🛡️ Modo admin ativado: somente administradores podem usar os comandos do bot. O grupo continua aberto para mensagens.'
                        : '✅ Modo admin desativado: os comandos do bot voltaram a ficar disponíveis para o grupo.'
                }, { quoted: m });
                break;

            case 'fechar':
                if (!isSenderAdmin) return;
                try {
                    await sock.groupSettingUpdate(jid, 'announcement');
                    await enviarAvisoAberturaFechamento(sock, jid, 'fechamento');
                } catch (errFechar) {
                    console.error(`[${command}] erro:`, errFechar.message);
                    await sock.sendMessage(jid, { text: '❌ Não consegui fechar o grupo. Confira se o bot é administrador.' });
                }
                break;
            case 'nomegrup': {
                if (!isSenderAdmin) return;
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: m });
                const novoNomeGrupo = args.join(' ').trim();
                if (!novoNomeGrupo) return sock.sendMessage(jid, { text: '❌ Informe o novo nome. Exemplo: *.nomegrup Família Silva*' }, { quoted: m });
                if (novoNomeGrupo.length > 25) return sock.sendMessage(jid, { text: '❌ O nome do grupo pode ter no máximo 25 caracteres.' }, { quoted: m });
                try {
                    await sock.groupUpdateSubject(jid, novoNomeGrupo);
                    await sock.sendMessage(jid, { text: `✅ Nome do grupo alterado para *${novoNomeGrupo}*.` }, { quoted: m });
                } catch (errNomeGrupo) {
                    console.error('[nomegrup] erro:', errNomeGrupo.message);
                    await sock.sendMessage(jid, { text: '❌ Não foi possível alterar o nome. Verifique se o bot é administrador.' }, { quoted: m });
                }
                break;
            }
            case 'descrição':
            case 'descricao': {
                if (!isSenderAdmin) return;
                if (!isGroup) return sock.sendMessage(jid, { text: '❌ Este comando só pode ser usado em grupos.' }, { quoted: m });
                const novaDescricaoGrupo = args.join(' ').trim();
                if (!novaDescricaoGrupo) return sock.sendMessage(jid, { text: '❌ Informe a descrição. Exemplo: *.descrição Grupo da família*' }, { quoted: m });
                if (novaDescricaoGrupo.length > 512) return sock.sendMessage(jid, { text: '❌ A descrição pode ter no máximo 512 caracteres.' }, { quoted: m });
                try {
                    await sock.groupUpdateDescription(jid, novaDescricaoGrupo);
                    await sock.sendMessage(jid, { text: '✅ Descrição do grupo alterada com sucesso.' }, { quoted: m });
                } catch (errDescricaoGrupo) {
                    console.error('[descricao] erro:', errDescricaoGrupo.message);
                    await sock.sendMessage(jid, { text: '❌ Não foi possível alterar a descrição. Verifique se o bot é administrador.' }, { quoted: m });
                }
                break;
            }
            case 'id':
                if (!isSenderAdmin) return;
                await sock.sendMessage(jid, { text: `🆔 *ID:* ${jid}` }, { quoted: m });
                break;
            case 'notificar':
                if (!isSenderAdmin) return;
                notificacoesAtivas[jid] = true;
                await sock.sendMessage(jid, { text: '🔔 Notificações ativadas.' });
                break;
            case 'naonotificar':
                if (!isSenderAdmin) return;
                notificacoesAtivas[jid] = false;
                await sock.sendMessage(jid, { text: '🔕 Notificações desativadas.' });
                break;
            case 'fixar': {
                if (!isSenderAdmin) return;
                const quotedFix = m.message.extendedTextMessage?.contextInfo;
                if (!quotedFix?.stanzaId) return sock.sendMessage(jid, { text: '❌ Responda à mensagem!' });
                const botJidF = jidNormalizedUser(sock.user.id);
                const partF = quotedFix.participant || quotedFix.remoteJid;
                try {
                    await sock.relayMessage(jid, { pinInChat: { key: { remoteJid: jid, fromMe: partF === botJidF, id: quotedFix.stanzaId, participant: partF }, type: 1, time: 2592000 } }, {});
                } catch { await sock.sendMessage(jid, { text: '   Erro ao fixar.' }); }
                break;
            }

            case 'cep':
                if (!isSenderAdmin) return;
                if (!args[0]) return sock.sendMessage(jid, { text: '❌ Informe o CEP!' });
                try {
                    const cepRes = await axios.get(`https://viacep.com.br/ws/${args[0].replace(/\D/g, '')}/json/`);
                    if (cepRes.data.erro) return sock.sendMessage(jid, { text: '❌ CEP não encontrado.' });
                    await sock.sendMessage(jid, { text: `📍 *CEP*\n📮 ${cepRes.data.cep}\n🏘️ ${cepRes.data.logradouro}\n🏢 ${cepRes.data.bairro}\n🏙️ ${cepRes.data.localidade} - ${cepRes.data.uf}` + logComando });
                } catch { await sock.sendMessage(jid, { text: '❌ Erro ao buscar CEP.' }); }
                break;

            case 'contador':
            case 'contado':
                if (!isSenderAdmin) return;
                contagemAtiva[jid] = !contagemAtiva[jid];
                await sock.sendMessage(jid, { text: `📊 Contagem: ${contagemAtiva[jid] ? '✅ ATIVADA' : '❌ DESATIVADA'}` }, { quoted: m });
                break;

            case 'bot_sorteia': {
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas administradores podem configurar o sorteio.' }, { quoted: m });
                const estadoAnterior = sorteiosAtivosPorGrupo[jid] === true;
                sorteiosAtivosPorGrupo[jid] = !estadoAnterior;
                const sincronizado = await syncEstadoBotToGithub();
                if (!sincronizado) {
                    if (estadoAnterior) sorteiosAtivosPorGrupo[jid] = true;
                    else delete sorteiosAtivosPorGrupo[jid];
                    return sock.sendMessage(jid, { text: '❌ Não consegui salvar a configuração no GitHub. Confira GITHUB_TOKEN e tente novamente.' }, { quoted: m });
                }
                await sock.sendMessage(jid, {
                    text: sorteiosAtivosPorGrupo[jid]
                        ? '✅ Sorteio automático ativado neste grupo. A cada 3 minutos o bot sorteará alguém e dará 1 ponto.'
                        : '🔕 Sorteio automático desativado neste grupo.'
                }, { quoted: m });
                break;
            }

            case 'ranking': {
                if (!isGroup) return;
                const pontosGrupo = pontosSorteio[jid] || {};
                const sorted = Object.entries(pontosGrupo)
                    .filter(([, pontos]) => Number.isFinite(pontos) && pontos >= MIN_PONTOS_RANKING)
                    .sort(([, pontosA], [, pontosB]) => pontosB - pontosA)
                    .slice(0, 10);
                if (!sorted.length) {
                    return sock.sendMessage(jid, { text: `🏆 Ainda não há participantes com ${MIN_PONTOS_RANKING} pontos ou mais. O bot sorteia novos pontos a cada 3 minutos.` }, { quoted: m });
                }
                let rankMsg = `🏆 *RANKING DE PONTOS — TOP 10*\n\n`;
                sorted.forEach(([usuario, pontos], indice) => {
                    rankMsg += `${indice + 1}º @${usuario.split('@')[0]} — ⭐ ${pontos} ponto(s)\n`;
                });
                rankMsg += `\nUse *.mutar @pessoa* para gastar ${PONTOS_POR_MUTAR} ponto ou *.roubar @pessoa* para tentar roubar 1 ponto (50% de chance).`;
                await sock.sendMessage(jid, { text: rankMsg, mentions: sorted.map(([usuario]) => usuario) }, { quoted: m });
                break;
            }

            case 'ativar_anagrama':
                if (!isSenderAdmin) return;
                if (anagramaGame.ativo) return sock.sendMessage(jid, { text: '🕹️ Jogo já ativo!' });
                const jogoA = gerarAnagrama();
                anagramaGame = { ativo: true, palavra: jogoA.original, embaralhada: jogoA.embaralhada, jid };
                await sock.sendMessage(jid, { text: `🎮 *ANAGRAMA!*\n\n🧩 *${anagramaGame.embaralhada}*` });
                break;

            case 'desativa_anagrama':
                if (!isSenderAdmin) return;
                anagramaGame.ativo = false;
                await sock.sendMessage(jid, { text: '🛑 Anagrama encerrado.' });
                break;

            case 'doar': {
                if (!isSenderAdmin) return;
                const userDoar = getMention();
                const valorDoar = parseInt(args[1]);
                if (!userDoar) return sock.sendMessage(jid, { text: '❌ Mencione alguém!' }, { quoted: m });
                if (isNaN(valorDoar)) return sock.sendMessage(jid, { text: '❌ Uso: .doar @user 400' }, { quoted: m });
                saldosUFSC[userDoar] = (saldosUFSC[userDoar] || 0) + valorDoar;
                await sock.sendMessage(jid, { text: `💰 @${userDoar.split('@')[0]} recebeu ${valorDoar} UFSC. Saldo: ${saldosUFSC[userDoar]}`, mentions: [userDoar] }, { quoted: m });
                break;
            }

            case 'aceitar': {
                if (!isSenderAdmin) return;
                let userAcc = getMention() || solicitacoesPendentes[jid];
                if (!userAcc) { try { const reqs = await sock.groupRequestParticipantsList(jid); if (reqs?.length) userAcc = reqs[0].jid; } catch {} }
                if (!userAcc) return sock.sendMessage(jid, { text: '❌ Sem solicitações pendentes.' });
                try {
                    await sock.groupRequestParticipantsUpdate(jid, [userAcc], 'approve');
                    try { analiseDiaria.registrarEvento('solicitacaoAprovada', jid); }
                    catch (erroRegistro) { console.error('[documento] falha ao salvar solicitação aprovada:', erroRegistro.message); }
                    await sock.sendMessage(jid, { text: `✅ @${userAcc.split('@')[0]} aprovado!`, mentions: [userAcc] });
                    delete solicitacoesPendentes[jid];
                }
                catch { await sock.sendMessage(jid, { text: '❌ Erro ao processar.' }); }
                break;
            }

            case 'recusar': {
                if (!isSenderAdmin) return;
                let userRec = getMention() || solicitacoesPendentes[jid];
                if (!userRec) { try { const reqs = await sock.groupRequestParticipantsList(jid); if (reqs?.length) userRec = reqs[0].jid; } catch {} }
                if (!userRec) return sock.sendMessage(jid, { text: '❌ Sem solicitações pendentes.' });
                await sock.groupRequestParticipantsUpdate(jid, [userRec], 'reject');
                try { analiseDiaria.registrarEvento('solicitacaoRejeitada', jid); }
                catch (erroRegistro) { console.error('[documento] falha ao salvar solicitação recusada:', erroRegistro.message); }
                await sock.sendMessage(jid, { text: `🚫 @${userRec.split('@')[0]} recusado.`, mentions: [userRec] });
                delete solicitacoesPendentes[jid];
                break;
            }

            case 'citar': {
                if (!isSenderAdmin) return;
                const ctx = m.message.extendedTextMessage?.contextInfo;
                if (!ctx?.stanzaId) return sock.sendMessage(jid, { text: '❌ Responda a uma mensagem!' }, { quoted: m });
                const tgt = ctx.participant || ctx.remoteJid;
                await sock.sendMessage(jid, { text: 'FLOODEM , INVADA AGORA' }, { quoted: { key: { remoteJid: jid, fromMe: tgt === jidNormalizedUser(sock.user.id), id: ctx.stanzaId, participant: tgt }, message: ctx.quotedMessage } });
                break;
            }

            case 'relatorio': {
                if (!isSenderAdmin) return;
                await sock.sendMessage(jid, { react: { text: '👍', key: m.key } });
                let relTexto = '📋 *RELATÓRIO DE COMANDOS*\n\n';
                if (!historicoComandos.length) relTexto += '_Nenhum comando registrado._';
                else historicoComandos.forEach((h, i) => { relTexto += `${i + 1}. .${h.comando} — @${h.usuario.split('@')[0]} : ${h.horario} : ${h.data}\n`; });
                if (relTexto.length > 3800) relTexto = relTexto.substring(0, 3800) + '\n⚠️ Relatório encurtado.';
                await sock.sendMessage(jid, { text: relTexto, mentions: historicoComandos.map(h => h.usuario) });
                break;
            }

            case 's':
            case 'sticker': {
                try {
                    if ((saldosUFSC[sender] || 0) < precoFigurinha) return sock.sendMessage(jid, { text: `❌ Saldo insuficiente. Precisa de ${precoFigurinha} UFSC. Atual: ${saldosUFSC[sender] || 0}` }, { quoted: m });
                    const quotedS = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const imgS = m.message.imageMessage || quotedS?.imageMessage;
                    if (!imgS) return sock.sendMessage(jid, { text: '❌ Envie ou responda uma foto com .s' }, { quoted: m });
                    try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
                    const stream = await downloadContentFromMessage(imgS, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    const sticker = new Sticker(buffer, { pack: 'Atrino Bot', author: 'Garibaldo356', type: StickerTypes.FULL });
                    await sock.sendMessage(jid, await sticker.toMessage());
                    saldosUFSC[sender] -= precoFigurinha;
                    await sock.sendMessage(jid, { text: `✅ Figurinha criada! 💰 Saldo: ${saldosUFSC[sender]} UFSC` });
                } catch (stkErr) { await sock.sendMessage(jid, { text: '❌ Erro ao criar figurinha.' }); }
                break;
            }

            case 'a':
            case 'animada': {
                try {
                    if ((saldosUFSC[sender] || 0) < precoFigurinha) return sock.sendMessage(jid, { text: '❌ Saldo insuficiente.' }, { quoted: m });
                    const quotedA = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const vidA = m.message.videoMessage || quotedA?.videoMessage;
                    if (!vidA) return sock.sendMessage(jid, { text: '❌ Envie ou responda um vídeo com .a' }, { quoted: m });
                    if (vidA.seconds > 10) return sock.sendMessage(jid, { text: '❌ Máximo 10 segundos.' }, { quoted: m });

                    const stream = await downloadContentFromMessage(vidA, 'video');
                    const partesVideo = [];
                    for await (const chunk of stream) partesVideo.push(chunk);
                    const videoBuffer = Buffer.concat(partesVideo);
                    const stickerWebp = await converterParaStickerAnimado(videoBuffer);
                    await sock.sendMessage(jid, { sticker: stickerWebp }, { quoted: m });
                    try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
                    saldosUFSC[sender] -= precoFigurinha;
                    await sock.sendMessage(jid, { text: `✅ Figurinha animada quadrada criada! 💰 Saldo: ${saldosUFSC[sender]} UFSC` }, { quoted: m });
                } catch (errStickerAnimada) {
                    console.error('[a] erro ao criar figurinha animada:', errStickerAnimada.message);
                    await sock.sendMessage(jid, { text: '❌ Não consegui converter esse vídeo em figurinha. Tente um clipe de até 10 segundos.' }, { quoted: m });
                }
                break;
            }

            case 'mat':
            case 'match': {
                try {
                    if ((saldosUFSC[sender] || 0) < precoFigurinha) return sock.sendMessage(jid, { text: '❌ Saldo insuficiente.' }, { quoted: m });
                    const mentM = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const t1 = body.toLowerCase().includes('@eu') ? sender : mentM[0];
                    const t2 = body.toLowerCase().includes('@eu') ? mentM[0] : mentM[1];
                    if (!t1 || !t2 || t1 === t2) return sock.sendMessage(jid, { text: '❌ Use: .mat @eu @pessoa ou .mat @p1 @p2' }, { quoted: m });
                    const p = Math.floor(Math.random() * 101);
                    const c = p > 75 ? '❤️‍🔥' : p > 50 ? '💖' : p > 25 ? '🧡' : '💔';
                    const f = p > 85 ? 'UM CASAL LENDÁRIO!' : p > 60 ? '💖 Tem futuro!' : p > 40 ? '⚖️ Pode rolar...' : '📉 Melhor na amizade.';
                    saldosUFSC[sender] -= precoFigurinha;
                    await sock.sendMessage(jid, { text: `💘 *ORÁCULO DO AMOR*\n\n@${t1.split('@')[0]} ${c} *${p}%* ${c} @${t2.split('@')[0]}\n\n${f}\n💰 Saldo: ${saldosUFSC[sender]}`, mentions: [t1, t2] }, { quoted: m });
                } catch (errMatch) {
                    console.error('[match] erro:', errMatch.message);
                    await sock.sendMessage(jid, { text: '❌ Erro ao criar o match.' }, { quoted: m });
                }
                break;
            }
        }
    });
}

startAtrinoBot();

process.on('uncaughtException', (err) => {
    console.error('❌ Exceção não capturada:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Promise rejeitada:', reason?.message || reason);
});
