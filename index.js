const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const cron = require('node-cron');
const http = require('http');
const axios = require('axios');
const fs = require('fs');
const { criarSessaoTriagem, adicionarMidiaTriagem, montarResumoTriagem } = require('./triagem');

const ffmpegPath = require('ffmpeg-static');
const fluentFfmpeg = require('fluent-ffmpeg');
fluentFfmpeg.setFfmpegPath(ffmpegPath);

const logger = P({ level: 'silent' });

// --- CONFIGURAÇÕES MASTER ---
const DONO_SUPREMO = '5521983161582@s.whatsapp.net';
const DONO_ADMIN   = '5521935052708@s.whatsapp.net';
const ID_DO_GRUPO  = '120363425471646460@g.us';

// --- ESTADO GERAL ---
let mutados = [];
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
let senhaRegistro = null;
let grupoTriagemAtivo = null;
const sessoesTriagem = {};
const triagensFinalizadas = new Set();

// ============================================================
// SISTEMA DE FILA SEQUENCIAL
// ============================================================
let filaAtiva         = false;
let linkGrupoTriagem  = null;
let contadorTicket    = 0;
const filaPendente    = [];   // { ticket, senderJid, numeroExibir, sessao }
let   filaEmAnalise   = null; // { ticket, senderJid, numeroExibir, status }

// ============================================================
// SISTEMA DE ADMINS DE TRIAGEM
// ============================================================
const adminsTriagem          = {}; // { jid: { apelido, senhaHash, triagensAprovadas, horarioMarcado } }
let   sessaoTriagemResponsavel = null; // jid do adm de plantão
let   metaTriagens           = 10;    // padrão 10, alterável

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

// --- busca último vídeo TikTok ---
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
    if (!config.token) return console.log('⚠️ GITHUB_TOKEN ausente.');
    const headers = { 'Authorization': `Bearer ${config.token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AtrinoBot-Sync' };
    try {
        const payload = { gruposRegistrados, grupoTriagemAtivo, linkGrupoTriagem, atualizadoEm: new Date().toISOString() };
        const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
        let sha;
        try { sha = (await axios.get(url, { headers })).data.sha; } catch {}
        await axios.put(url, {
            message: `Update bot state: ${new Date().toISOString()}`,
            content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
            sha
        }, { headers });
        console.log('✅ Estado sincronizado com GitHub.');
    } catch (err) { console.error('❌ Erro GitHub:', err.response?.data?.message || err.message); }
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
        grupoTriagemAtivo = payload.grupoTriagemAtivo || null;
        linkGrupoTriagem = payload.linkGrupoTriagem || null;
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
// FILA SEQUENCIAL — envia próxima triagem ao grupo
// ============================================================
async function enviarProximaTriagemAoGrupo(sockInstance) {
    if (filaEmAnalise) return;
    if (!filaPendente.length) return;

    const proxima = filaPendente.shift();
    const responsavelApelido = sessaoTriagemResponsavel && adminsTriagem[sessaoTriagemResponsavel]
        ? adminsTriagem[sessaoTriagemResponsavel].apelido
        : 'Não definido';

    filaEmAnalise = {
        ticket: proxima.ticket,
        senderJid: proxima.senderJid,
        numeroExibir: proxima.numeroExibir,
        status: 'aguardando'
    };

    const sessao = proxima.sessao;
    const numeroExibir = proxima.numeroExibir;

    try {
        await sockInstance.sendMessage(grupoTriagemAtivo, {
            text: `📋 *TRIAGEM #${proxima.ticket}*\n\n📱 Número: ${numeroExibir}\n📲 WhatsApp: ${proxima.senderJid.split('@')[0]}\n👔 Responsável: ${responsavelApelido}\n\n${montarResumoTriagem(sessao)}\n\nUse *.aprovar ${proxima.ticket}* ou *.reprovar ${proxima.ticket}*`
        });

        for (let i = 0; i < sessao.imagens.length; i++) {
            try {
                await sockInstance.sendMessage(grupoTriagemAtivo, {
                    document: sessao.imagens[i], mimetype: 'image/jpeg',
                    fileName: `print_${numeroExibir}_${i + 1}.jpg`,
                    caption: `🖼️ Print ${i + 1} — ${numeroExibir}`
                });
            } catch {}
        }
        for (let i = 0; i < sessao.audios.length; i++) {
            try {
                await sockInstance.sendMessage(grupoTriagemAtivo, {
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
// SERVIDOR WEB (QR + painel)
// ============================================================
const PORT = parseInt(process.env.PORT, 10) || 7860;

http.createServer((req, res) => {
    if (req.url === '/gerar-senha') {
        senhaRegistro = Math.random().toString(36).substring(2, 8).toUpperCase();
        res.writeHead(302, { 'Location': '/' }); res.end(); return;
    }
    if (!qrAtual) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><head><title>Atrino Bot</title>
        <style>body{font-family:Arial,sans-serif;text-align:center;margin-top:80px;background:#0f0c1b;color:#00ffcc}
        .card{background:#17142b;display:inline-block;padding:40px;border-radius:15px;border:1px solid #3d3475}
        .btn{display:inline-block;margin-top:20px;padding:15px 30px;background:#00ffcc;color:#0f0c1b;text-decoration:none;border-radius:8px;font-weight:bold}
        .senha{font-size:2em;background:#111;padding:10px 20px;border-radius:10px;margin:20px 0;border:2px dashed #00ffcc;display:block}</style></head>
        <body><div class="card"><h1>🚀 Atrino Bot: Conectado!</h1>
        ${senhaRegistro ? `<p>Senha:</p><span class="senha">${senhaRegistro}</span><p>.registrar ${senhaRegistro}</p>` : '<p style="color:#ee5253">Nenhuma senha ativa.</p>'}
        <a href="/gerar-senha" class="btn">🔄 GERAR SENHA</a></div></body></html>`);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>Atrino Bot - QR</title><meta http-equiv="refresh" content="5">
    <style>body{font-family:Arial;text-align:center;margin-top:50px;background:#111;color:#fff}</style></head>
    <body><h1 style="color:#25D366">Escaneie o QR Code</h1>
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrAtual)}" style="border:10px solid white;border-radius:10px"/>
    </body></html>`);
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🛰️ Servidor ativo na porta ${PORT}`);
    setInterval(() => { http.get(`http://localhost:${PORT}`).on('error', () => {}); }, 60000);
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

async function startAtrinoBot() {
    await loadEstadoBotFromGithub();

    if (!fs.existsSync('auth_info')) {
        fs.mkdirSync('auth_info', { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        logger, auth: state, printQRInTerminal: false,
        browser: ['Mac OS', 'Chrome', '121.0.0.0'],
        connectTimeoutMs: 120000, keepAliveIntervalMs: 30000,
        markOnline: true, shouldSyncHistoryMessage: () => false,
        receivedPendingNotifications: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // --- BOAS-VINDAS ---
    sock.ev.on('group-participants.update', async (anu) => {
        if (anu.action === 'add') {
            if (!notificacoesAtivas[anu.id]) return;
            for (const participant of anu.participants) {
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
        try { await sock.groupSettingUpdate(ID_DO_GRUPO, 'announcement'); await sock.sendMessage(ID_DO_GRUPO, { text: `╭─── [ 🔒 *SALÃO ENCERRADO* ] ───╮\n│ 🌑 Horário de descanso: 00:00h\n╰─────────────────────╯` }); } catch {}
    }, { timezone: 'America/Sao_Paulo' });

    cron.schedule('0 4 * * *', async () => {
        try { await sock.groupSettingUpdate(ID_DO_GRUPO, 'not_announcement'); await sock.sendMessage(ID_DO_GRUPO, { text: `╭─── [ 🔓 *SALÃO ABERTO* ] ───╮\n│ 🌅 Horário de despertar: 04:00h\n╰─────────────────────╯` }); } catch {}
    }, { timezone: 'America/Sao_Paulo' });

    cron.schedule('*/5 * * * *', async () => {
        if (Object.keys(alertasTikTok).length > 0) await checarNovosTikToks(sock);
    });

    // --- CONEXÃO E TRATAMENTO DE ERROS CORRIGIDO ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrAtual = qr;
            console.log('\n🔗 Novo QR Code gerado. Escaneie pelo navegador ou terminal:');
            console.log('https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr));
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            qrAtual = null;
            console.log('\n✅ ATRINO BOT ONLINE E CONECTADO COM SUCESSO!\n');
        }

        if (connection === 'close') {
            qrAtual = null;
            const error = lastDisconnect?.error;
            const statusCode = error instanceof Boom ? error.output?.statusCode : error?.output?.statusCode;

            console.log(`❌ Conexão fechada. Motivo / StatusCode: ${statusCode}`);
            if (error) console.log('Detalhes do erro:', error?.message || error);

            const errosFatais = [
                DisconnectReason.loggedOut,
                DisconnectReason.badSession,
                DisconnectReason.connectionReplaced,
                401, 403, 405
            ];

            const deveLimparSessao = errosFatais.includes(statusCode);

            if (deveLimparSessao) {
                console.log('⚠️ Erro fatal/Sessão inválida detectada. Apagando pasta auth_info...');
                if (fs.existsSync('auth_info')) {
                    try {
                        fs.rmSync('auth_info', { recursive: true, force: true });
                        console.log('🧹 Pasta auth_info limpa com sucesso.');
                    } catch (errClean) {
                        console.error('Erro ao limpar auth_info:', errClean.message);
                    }
                }
                console.log('🔄 Reiniciando bot em 5 segundos para gerar novo QR Code...');
                setTimeout(() => startAtrinoBot(), 5000);
            } else {
                console.log('🔄 Desconexão temporária. Tentando reconectar em 5 segundos...');
                setTimeout(() => startAtrinoBot(), 5000);
            }
        }
    });

    // ============================================================
    // HANDLER PRINCIPAL DE MENSAGENS
    // ============================================================
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid     = m.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const sender  = m.key.participant || m.key.remoteJid;
        const body    = (m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || '');

        // --- recebe mídia no PV durante triagem ---
        if (!isGroup && !m.message.conversation && !m.message.extendedTextMessage?.text) {
            const sessao = sessoesTriagem[sender];
            if (sessao && grupoTriagemAtivo) {
                const media = await baixarMidiaDoMensagem(sock, m.message);
                if (media) adicionarMidiaTriagem(sessao, media.tipo, media.buffer);
            }
        }

        // --- captura número informado em texto ---
        if (!isGroup) {
            const sessao = sessoesTriagem[sender];
            const txt = m.message.conversation || m.message.extendedTextMessage?.text || '';
            if (sessao && txt && !txt.startsWith('.')) {
                const matchNumero = txt.match(/[\d\s\-\+\(\)]{7,}/);
                if (matchNumero) sessao.numeroInformado = matchNumero[0].replace(/[\s\-]/g, '').trim();
            }
        }

        // --- reset por inatividade ---
        const agoraMs = Date.now();
        if (ultimaInteracao[sender] && (agoraMs - ultimaInteracao[sender]) > 5 * 24 * 60 * 60 * 1000) {
            saldosUFSC[sender] = 0;
        }
        ultimaInteracao[sender] = agoraMs;

        // --- contagem de atividade ---
        if (contagemAtiva[jid]) {
            if (!estatisticas[jid]) estatisticas[jid] = {};
            if (!estatisticas[jid][sender]) estatisticas[jid][sender] = { mensagens: 0, fotos: 0, videos: 0, figurinhas: 0, total: 0 };
            const ua = estatisticas[jid][sender];
            ua.total++;
            if (m.message.conversation || m.message.extendedTextMessage) ua.mensagens++;
            else if (m.message.imageMessage) ua.fotos++;
            else if (m.message.videoMessage) ua.videos++;
            else if (m.message.stickerMessage) ua.figurinhas++;
        }

        // ============================================================
        // COMANDOS DO PV (triagem)
        // ============================================================
        if (!isGroup && body.startsWith('.')) {
            const pvArgs    = body.slice(1).trim().split(/ +/);
            const pvCommand = pvArgs.shift().toLowerCase();

            try {
                if (pvCommand === 'triagem') {
                    if (!grupoTriagemAtivo) return sock.sendMessage(jid, { text: '⚠️ Nenhum grupo ativou a triagem no momento.' });
                    if (triagensFinalizadas.has(sender)) return sock.sendMessage(jid, { text: '❌ Você já realizou sua triagem. Não é permitido enviar mais de uma vez.' });

                    if (!sessoesTriagem[sender]) {
                        sessoesTriagem[sender] = criarSessaoTriagem(sender, grupoTriagemAtivo);

                        sessoesTriagem[sender]._expiracao = setTimeout(async () => {
                            if (sessoesTriagem[sender]) {
                                delete sessoesTriagem[sender];
                                triagensFinalizadas.delete(sender);
                                try { await sock.sendMessage(sender, { text: '⏰ Sua triagem expirou por inatividade (2 minutos sem finalizar). Se desejar, inicie novamente com *.triagem*.' }); } catch {}
                                try { await sock.sendMessage(grupoTriagemAtivo, { text: `⏰ Triagem de *${sender.split('@')[0]}* expirou por inatividade (2 min sem .finalizar).` }); } catch {}
                            }
                        }, 2 * 60 * 1000);
                    }

                    const responsavelApelido = sessaoTriagemResponsavel && adminsTriagem[sessaoTriagemResponsavel]
                        ? adminsTriagem[sessaoTriagemResponsavel].apelido : 'Equipe';

                    return sock.sendMessage(jid, {
                        text: `Para fazer sua triagem:\n\n1️⃣ Informe seu número de celular\n2️⃣ Mande os prints com as contas de email\n3️⃣ Mande 2 áudios ou 1 áudio dos personagens\n4️⃣ Quando terminar, diga *.finalizar*\n\n👔 Responsável pela triagem: *${responsavelApelido}*`
                    });
                }

                if (pvCommand === 'finalizar') {
                    const sessao = sessoesTriagem[sender];
                    if (!sessao) return sock.sendMessage(jid, { text: '⚠️ Você ainda não iniciou uma triagem. Envie *.triagem* primeiro.' });
                    if (!grupoTriagemAtivo) { delete sessoesTriagem[sender]; return sock.sendMessage(jid, { text: '⚠️ Nenhum grupo está recebendo triagens no momento.' }); }

                    if (sessao._expiracao) { clearTimeout(sessao._expiracao); delete sessao._expiracao; }

                    const numeroExibir = sessao.numeroInformado || sender.split('@')[0];

                    delete sessoesTriagem[sender];
                    triagensFinalizadas.add(sender);
                    contadorTicket++;
                    const ticket = contadorTicket;

                    filaPendente.push({ ticket, senderJid: sender, numeroExibir, sessao });

                    const posicaoFila = filaPendente.length + (filaEmAnalise ? 1 : 0);
                    await sock.sendMessage(sender, {
                        text: `✅ Triagem enviada!\n\n🎫 *Ticket: #${ticket}*\n📊 Posição na fila: *${posicaoFila}º*\n\n⏳ Você será notificado(a) assim que sua triagem for analisada.`
                    });

                    if (!filaEmAnalise) await enviarProximaTriagemAoGrupo(sock);
                    return;
                }
            } catch (cmdErr) {
                console.error(`[PV] .${pvCommand}:`, cmdErr);
                try { await sock.sendMessage(jid, { text: `❌ Erro interno: ${cmdErr.message}` }); } catch {}
            }
            return;
        }

        if (!isGroup) return;

        // --- anagrama ---
        if (anagramaGame.ativo && anagramaGame.jid === jid && body.toLowerCase() === anagramaGame.palavra) {
            saldosUFSC[sender] = (saldosUFSC[sender] || 0) + 1;
            await sock.sendMessage(jid, { text: `🎉 *ACERTOU!* @${sender.split('@')[0]} ganhou 1 UFSC! 💰 Saldo: ${saldosUFSC[sender]}`, mentions: [sender] });
            const novo = gerarAnagrama();
            anagramaGame.palavra = novo.original; anagramaGame.embaralhada = novo.embaralhada;
            return sock.sendMessage(jid, { text: `🧩 *${anagramaGame.embaralhada}*` });
        }

        // --- mutados ---
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

        if (body.includes('@name') && isSenderAdmin) {
            const meta = await sock.groupMetadata(jid);
            await sock.sendMessage(jid, { text: `📢 *Chamada Geral!*`, mentions: meta.participants.map(p => p.id) });
        }

        // --- CAPTURA ESCOLHA DE HORÁRIO ---
        if (adminsTriagem[sender]?._aguardandoEscolha && /^[1-6]$/.test(body.trim())) {
            const dadosAdm = adminsTriagem[sender];
            const idx = parseInt(body.trim()) - 1;
            if (dadosAdm._slotsDisponiveis?.[idx]) {
                dadosAdm.horarioMarcado = dadosAdm._slotsDisponiveis[idx];
                dadosAdm._aguardandoEscolha = false;
                delete dadosAdm._slotsDisponiveis;
                sessaoTriagemResponsavel = sender;
                await sock.sendMessage(jid, {
                    text: `✅ *Plantão marcado!*\n\n👔 *${dadosAdm.apelido}* está de plantão agora\n🕐 Horário marcado: *${dadosAdm.horarioMarcado}*\n\nApenas você pode aprovar/reprovar as triagens desta sessão.`,
                    mentions: [sender]
                });
            }
            return;
        }

        if (!body.startsWith('.')) return;

        const args    = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        if (!gruposRegistrados.includes(jid) && command !== 'registrar') return;

        const agoraCmd   = new Date();
        const horarioCmd = agoraCmd.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const dataCmd    = agoraCmd.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const logComando = `\n\n*CMD:* @${sender.split('@')[0]} : ${horarioCmd} : ${dataCmd}`;

        historicoComandos.push({ comando: command, usuario: sender, horario: horarioCmd, data: dataCmd });
        if (historicoComandos.length > 50) historicoComandos.shift();

        const agora = Date.now();
        if (cooldowns[sender] && agora < cooldowns[sender] + 10000) {
            const r = ((cooldowns[sender] + 10000 - agora) / 1000).toFixed(1);
            return sock.sendMessage(jid, { text: `⏳ Aguarde ${r}s.` }, { quoted: m });
        }
        cooldowns[sender] = agora;

        if (command.startsWith('mudapreço_fig_')) {
            if (!isSenderAdmin) return;
            const novoPreco = parseInt(command.split('_').pop());
            if (isNaN(novoPreco)) return sock.sendMessage(jid, { text: '❌ Valor inválido.' });
            precoFigurinha = novoPreco;
            return sock.sendMessage(jid, { text: `✅ Preço figurinha: *${precoFigurinha} UFSC*` });
        }

        let mentions  = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const getMention = () => mentions[0] || m.message.extendedTextMessage?.contextInfo?.participant;

        if (sender === DONO_SUPREMO && command === 'off') { botSilenciado = true; return sock.sendMessage(jid, { text: '🔇 Bot OFF.' }); }
        if (sender === DONO_SUPREMO && command === 'on')  { botSilenciado = false; return sock.sendMessage(jid, { text: '🔊 Bot ON.' }); }
        if (botSilenciado) return;

        switch (command) {

            // --------------------------------------------------------
            // MENU
            // --------------------------------------------------------
            case 'menu':
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas administradores.' }, { quoted: m });
                await sock.sendMessage(jid, { text: `╭─── [ ATRINO BOT ] ───╮
│
│ 🧑‍🤝‍🧑 *Membros:*
│ ➥ .registrar - Ativar bot
│ ➥ .desativa_bot - Desativar bot
│ ➥ .s / .a - Figurinhas
│ ➥ .mat @user - Match
│
│ 📋 *Triagem:*
│ ➥ .ativar_triagem - Ativar triagem
│ ➥ .desativar_triagem - Desativar triagem
│ ➥ .ativar_fila - Ativar fila sequencial
│ ➥ .desativar_fila - Desativar fila
│ ➥ .registrar_link <link> - Link do grupo destino
│ ➥ .registrar_adm @name apelido senha - Cadastrar adm triagem
│ ➥ .login_triagem senha - Fazer login e marcar horário
│ ➥ .aprovar <ticket> - Aprovar triagem
│ ➥ .reprovar <ticket> - Reprovar triagem
│ ➥ .metas - Ver painel de metas
│ ➥ .alterar_meta <num> - Alterar meta alvo
│
│ 👮 *Admin:*
│ ➥ .cep [cep] - Consulta CEP
│ ➥ .contador - Ativar/Desativar contagem
│ ➥ .doar @user [val] - Dar moedas
│ ➥ .id - Ver ID do grupo
│ ➥ .ranking - Mais ativos
│ ➥ .ativar_anagrama / .desativa_anagrama
│ ➥ .notificar / .naonotificar
│ ➥ .alert_tiktok @user / .remover_alert_tiktok
│ ➥ .tornaadm @user / .rebaixar @user
│ ➥ .totag - Marcar todos
│ ➥ .adv / .unadv @user - Advertências
│ ➥ .mute / .desmute @user
│ ➥ .fixar / .ban / .abrir / .fechar
│ ➥ .relatorio / @name
│
╰───────────────────╯` + logComando, mentions: [sender] }, { quoted: m });
                break;

            // --------------------------------------------------------
            // REGISTRO DO GRUPO
            // --------------------------------------------------------
            case 'registrar':
                if (!isSenderAdmin) return;
                if (!senhaRegistro || args[0] !== senhaRegistro) return sock.sendMessage(jid, { text: '❌ Senha incorreta ou expirada.' }, { quoted: m });
                if (!gruposRegistrados.includes(jid)) gruposRegistrados.push(jid);
                senhaRegistro = null;
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: '✅ Bot registrado com sucesso neste grupo!' }, { quoted: m });
                break;

            case 'desativa_bot':
                if (!isSenderAdmin) return;
                gruposRegistrados = gruposRegistrados.filter(g => g !== jid);
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: '🔴 Bot desativado para este grupo.' }, { quoted: m });
                break;

            // --------------------------------------------------------
            // TRIAGEM — ATIVAR / DESATIVAR / CONFIGS
            // --------------------------------------------------------
            case 'ativar_triagem':
                if (!isSenderAdmin) return;
                grupoTriagemAtivo = jid;
                triagensFinalizadas.clear();
                filaPendente.length = 0;
                filaEmAnalise = null;
                contadorTicket = 0;
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: '✅ Triagem ativada! Membros podem enviar *.triagem* no privado.' }, { quoted: m });
                break;

            case 'desativar_triagem':
                if (!isSenderAdmin) return;
                if (grupoTriagemAtivo !== jid) return sock.sendMessage(jid, { text: '⚠️ Triagem não está ativa aqui.' }, { quoted: m });
                grupoTriagemAtivo = null;
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: '🔴 Triagem desativada.' }, { quoted: m });
                break;

            case 'ativar_fila':
                if (!isSenderAdmin) return;
                filaAtiva = true;
                await sock.sendMessage(jid, { text: '✅ Fila sequencial ativada!' }, { quoted: m });
                break;

            case 'desativar_fila':
                if (!isSenderAdmin) return;
                filaAtiva = false;
                await sock.sendMessage(jid, { text: '🔴 Fila sequencial desativada.' }, { quoted: m });
                break;

            case 'registrar_link':
                if (!isSenderAdmin) return;
                if (!args[0]) return sock.sendMessage(jid, { text: '❌ Informe o link do grupo. Ex: `.registrar_link https://chat.whatsapp.com/...`' }, { quoted: m });
                linkGrupoTriagem = args[0].trim();
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: `✅ Link registrado com sucesso:\n${linkGrupoTriagem}` }, { quoted: m });
                break;

            case 'registrar_adm':
                if (!isSenderAdmin) return;
                const alvoAdm = getMention();
                if (!alvoAdm) return sock.sendMessage(jid, { text: '❌ Mencione o admin. Ex: `.registrar_adm @user Apelido Senha`' }, { quoted: m });
                const admApelido = args[1];
                const admSenha   = args[2];
                if (!admApelido || !admSenha) return sock.sendMessage(jid, { text: '❌ Use: `.registrar_adm @user <apelido> <senha>`' }, { quoted: m });
                adminsTriagem[alvoAdm] = {
                    apelido: admApelido,
                    senhaHash: hashSenha(admSenha),
                    triagensAprovadas: 0,
                    horarioMarcado: null
                };
                await sock.sendMessage(jid, { text: `✅ Admin de triagem cadastrado!\n👤 Apelido: *${admApelido}*` }, { quoted: m });
                break;

            case 'login_triagem':
                const senhaDig = args[0];
                if (!senhaDig) return sock.sendMessage(jid, { text: '❌ Use: `.login_triagem <senha>`' }, { quoted: m });
                const dadosAdm = adminsTriagem[sender];
                if (!dadosAdm) return sock.sendMessage(jid, { text: '❌ Você não está cadastrado como admin de triagem.' }, { quoted: m });
                if (dadosAdm.senhaHash !== hashSenha(senhaDig)) return sock.sendMessage(jid, { text: '❌ Senha incorreta!' }, { quoted: m });

                const slots = gerarHorariosDisponiveis();
                dadosAdm._aguardandoEscolha = true;
                dadosAdm._slotsDisponiveis  = slots;

                let txtLogin = `✅ *Login efetuado com sucesso, ${dadosAdm.apelido}!*\n\nSelecione seu horário de plantão respondendo com o *número (1 a 6)*:\n\n`;
                slots.forEach((s, idx) => { txtLogin += `${idx + 1}️⃣ ${s}\n`; });
                await sock.sendMessage(jid, { text: txtLogin }, { quoted: m });
                break;

            case 'aprovar':
                if (!isSenderAdmin && !adminsTriagem[sender]) return;
                const ticketAprovar = parseInt(args[0]);
                if (!ticketAprovar) return sock.sendMessage(jid, { text: '❌ Informe o ticket. Ex: `.aprovar 1`' }, { quoted: m });

                if (filaEmAnalise && filaEmAnalise.ticket === ticketAprovar) {
                    const ticketObj = filaEmAnalise;
                    filaEmAnalise = null;

                    if (adminsTriagem[sender]) adminsTriagem[sender].triagensAprovadas++;

                    await sock.sendMessage(jid, { text: `✅ *Triagem #${ticketAprovar} APROVADA!*` }, { quoted: m });

                    try {
                        let msgAprovado = `🎉 *Sua triagem foi APROVADA!*`;
                        if (linkGrupoTriagem) msgAprovado += `\n\nEntre no grupo pelo link:\n${linkGrupoTriagem}`;
                        await sock.sendMessage(ticketObj.senderJid, { text: msgAprovado });
                    } catch {}

                    await enviarProximaTriagemAoGrupo(sock);
                } else {
                    sock.sendMessage(jid, { text: `⚠️ Ticket #${ticketAprovar} não está em análise no topo da fila.` }, { quoted: m });
                }
                break;

            case 'reprovar':
                if (!isSenderAdmin && !adminsTriagem[sender]) return;
                const ticketReprovar = parseInt(args[0]);
                if (!ticketReprovar) return sock.sendMessage(jid, { text: '❌ Informe o ticket. Ex: `.reprovar 1`' }, { quoted: m });

                if (filaEmAnalise && filaEmAnalise.ticket === ticketReprovar) {
                    const ticketObj = filaEmAnalise;
                    filaEmAnalise = null;

                    await sock.sendMessage(jid, { text: `❌ *Triagem #${ticketReprovar} REPROVADA!*` }, { quoted: m });

                    try {
                        await sock.sendMessage(ticketObj.senderJid, { text: `❌ Sua triagem não foi aprovada. Entre em contato com a administração.` });
                    } catch {}

                    await enviarProximaTriagemAoGrupo(sock);
                } else {
                    sock.sendMessage(jid, { text: `⚠️ Ticket #${ticketReprovar} não está em análise no topo da fila.` }, { quoted: m });
                }
                break;

            case 'metas':
                if (!isSenderAdmin) return;
                let txtMetas = `📊 *PAINEL DE METAS DE TRIAGEM*\n🎯 Meta atual: *${metaTriagens} triagens*\n\n`;
                if (Object.keys(adminsTriagem).length === 0) {
                    txtMetas += `Nenhum admin cadastrado.`;
                } else {
                    for (const [admJid, admData] of Object.entries(adminsTriagem)) {
                        const pct = Math.min(100, Math.round((admData.triagensAprovadas / metaTriagens) * 100));
                        const barra = '🟩'.repeat(Math.floor(pct / 10)) + '⬜'.repeat(10 - Math.floor(pct / 10));
                        txtMetas += `👤 *${admData.apelido}*\n Progresso: ${admData.triagensAprovadas}/${metaTriagens} [${pct}%]\n ${barra}\n\n`;
                    }
                }
                await sock.sendMessage(jid, { text: txtMetas }, { quoted: m });
                break;

            case 'alterar_meta':
                if (!isSenderAdmin) return;
                const novaMeta = parseInt(args[0]);
                if (!novaMeta || novaMeta <= 0) return sock.sendMessage(jid, { text: '❌ Informe um número válido.' }, { quoted: m });
                metaTriagens = novaMeta;
                await sock.sendMessage(jid, { text: `✅ Meta de triagens alterada para *${metaTriagens}*!` }, { quoted: m });
                break;

            // --------------------------------------------------------
            // FERRAMENTAS E OUTROS COMANDOS
            // --------------------------------------------------------
            case 'cep':
                const cepInput = args[0]?.replace(/\D/g, '');
                if (!cepInput || cepInput.length !== 8) return sock.sendMessage(jid, { text: '❌ Informe um CEP válido com 8 dígitos.' }, { quoted: m });
                try {
                    const resCep = await axios.get(`https://viacep.com.br/ws/${cepInput}/json/`);
                    if (resCep.data.erro) return sock.sendMessage(jid, { text: '❌ CEP não encontrado.' }, { quoted: m });
                    const c = resCep.data;
                    await sock.sendMessage(jid, { text: `📍 *CONSULTA CEP*\n\n📮 CEP: ${c.cep}\n🏙️ Cidade: ${c.localidade} - ${c.uf}\n🏡 Bairro: ${c.bairro}\n🛣️ Logradouro: ${c.logradouro}` }, { quoted: m });
                } catch {
                    sock.sendMessage(jid, { text: '❌ Erro ao consultar CEP.' }, { quoted: m });
                }
                break;

            case 's':
            case 'a':
                const isQuotedImage = m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
                const isQuotedVideo = m.message.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage;
                const isDirectImage = m.message.imageMessage;
                const isDirectVideo = m.message.videoMessage;

                const targetMessage = isQuotedImage || isQuotedVideo ? m.message.extendedTextMessage.contextInfo.quotedMessage : m.message;

                if (!isQuotedImage && !isQuotedVideo && !isDirectImage && !isDirectVideo) {
                    return sock.sendMessage(jid, { text: '❌ Envie ou responda a uma imagem/vídeo para criar a figurinha.' }, { quoted: m });
                }

                try {
                    const mediaType = (isQuotedImage || isDirectImage) ? 'image' : 'video';
                    const stream = await downloadContentFromMessage(targetMessage[`${mediaType}Message`], mediaType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                    const sticker = new Sticker(buffer, {
                        pack: 'Atrino Bot', author: 'Atrino',
                        type: StickerTypes.FULL, quality: 70
                    });

                    const stickerBuffer = await sticker.toBuffer();
                    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: m });
                } catch (stkErr) {
                    console.error('Erro ao gerar figurinha:', stkErr);
                    sock.sendMessage(jid, { text: '❌ Falha ao converter em figurinha.' }, { quoted: m });
                }
                break;

            case 'id':
                await sock.sendMessage(jid, { text: `🆔 ID deste grupo/chat:\n\`${jid}\`` }, { quoted: m });
                break;

            case 'totag':
                if (!isSenderAdmin) return;
                try {
                    const metaGroup = await sock.groupMetadata(jid);
                    const todos = metaGroup.participants.map(p => p.id);
                    const aviso = args.join(' ') || 'Atenção todos!';
                    await sock.sendMessage(jid, { text: `📢 *AVISO*\n\n${aviso}`, mentions: todos });
                } catch {}
                break;

            case 'doar':
                if (!isSenderAdmin) return;
                const alvoDoacao = getMention();
                const valorDoacao = parseInt(args[1] || args[0]);
                if (!alvoDoacao || isNaN(valorDoacao)) return sock.sendMessage(jid, { text: '❌ Use: `.doar @user <quantidade>`' }, { quoted: m });
                saldosUFSC[alvoDoacao] = (saldosUFSC[alvoDoacao] || 0) + valorDoacao;
                await sock.sendMessage(jid, { text: `💰 Adicionados *${valorDoacao} UFSC* para @${alvoDoacao.split('@')[0]}!\nSaldo total: ${saldosUFSC[alvoDoacao]}`, mentions: [alvoDoacao] }, { quoted: m });
                break;

            case 'contador':
                if (!isSenderAdmin) return;
                contagemAtiva[jid] = !contagemAtiva[jid];
                await sock.sendMessage(jid, { text: contagemAtiva[jid] ? '📊 Contagem de mensagens *ATIVADA*!' : '🔴 Contagem de mensagens *DESATIVADA*!' }, { quoted: m });
                break;

            case 'ranking':
                if (!estatisticas[jid]) return sock.sendMessage(jid, { text: '⚠️ Nenhuma estatística coletada ainda. Ative com `.contador`.' }, { quoted: m });
                const ordenados = Object.entries(estatisticas[jid]).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
                let txtRank = `🏆 *RANKING DOS MAIS ATIVOS*\n\n`;
                ordenados.forEach(([uJid, st], idx) => {
                    txtRank += `${idx + 1}º @${uJid.split('@')[0]} — *${st.total}* msgs (${st.mensagens} txt, ${st.fotos} fotos, ${st.figurinhas} figs)\n`;
                });
                await sock.sendMessage(jid, { text: txtRank, mentions: ordenados.map(x => x[0]) }, { quoted: m });
                break;

            default:
                break;
        }
    });
}

// Iniciar Aplicação
startAtrinoBot();
