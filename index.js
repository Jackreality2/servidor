const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const cron = require('node-cron');
const http = require('http');
const axios = require('axios');
const fs = require('fs');

const ffmpegPath = require('ffmpeg-static');
const fluentFfmpeg = require('fluent-ffmpeg');
fluentFfmpeg.setFfmpegPath(ffmpegPath);

const logger = P({ level: 'silent' });

// --- MÓDULO AUXILIAR DE TRIAGEM ---
function criarSessaoTriagem(senderJid, grupoJid) {
    return {
        senderJid,
        grupoJid,
        numeroInformado: null,
        imagens: [],
        audios: [],
        criadoEm: new Date()
    };
}

function adicionarMidiaTriagem(sessao, tipo, buffer) {
    if (tipo === 'image') sessao.imagens.push(buffer);
    if (tipo === 'audio') sessao.audios.push(buffer);
}

function montarResumoTriagem(sessao) {
    return `🖼️ Prints anexados: *${sessao.imagens.length}*\n🎧 Áudios anexados: *${sessao.audios.length}*`;
}

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
const filaPendente    = [];   
let   filaEmAnalise   = null; 

// ============================================================
// SISTEMA DE ADMINS DE TRIAGEM
// ============================================================
const adminsTriagem          = {};
let   sessaoTriagemResponsavel = null; 
let   metaTriagens           = 10;    

// ============================================================
// SISTEMA DE ALERTA TIKTOK
// ============================================================
const alertasTikTok = {};

// --- Hash para senha ---
function hashSenha(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
    return h.toString(16);
}

// --- Busca último vídeo TikTok ---
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
        const payload = { gruposRegistrados, grupoTriagemAtivo, atualizadoEm: new Date().toISOString() };
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

// ============================================================
// BOT PRINCIPAL
// ============================================================
async function startAtrinoBot() {
    await loadEstadoBotFromGithub();
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        logger, auth: state, printQRInTerminal: true,
        browser: ['Bot WhatsApp', 'Chrome', '1.0.0'],
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

    // --- GERENCIAMENTO DE CONEXÃO ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrAtual = qr;
            console.log('\n🔗 QR: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr));
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') { 
            qrAtual = null; 
            console.log('\n✅ ATRINO BOT ONLINE!\n'); 
        }
        if (connection === 'close') {
            qrAtual = null;
            const statusCode = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode 
                : lastDisconnect?.error?.code;

            console.log(`⚠️ Conexão fechada. Motivo: ${statusCode}`);

            const deveReconectar = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;

            if (deveReconectar) { 
                console.log('🔄 Reconectando...'); 
                startAtrinoBot(); 
            } else {
                console.log('❌ Sessão encerrada/expirada. É necessário escanear um novo QR Code.');
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

        // --- Mídia enviada na triagem PV ---
        if (!isGroup && !m.message.conversation && !m.message.extendedTextMessage?.text) {
            const sessao = sessoesTriagem[sender];
            if (sessao && grupoTriagemAtivo) {
                const media = await baixarMidiaDoMensagem(sock, m.message);
                if (media) adicionarMidiaTriagem(sessao, media.tipo, media.buffer);
            }
        }

        // --- Coleta de número digitado na triagem PV ---
        if (!isGroup) {
            const sessao = sessoesTriagem[sender];
            const txt = m.message.conversation || m.message.extendedTextMessage?.text || '';
            if (sessao && txt && !txt.startsWith('.')) {
                const matchNumero = txt.match(/[\d\s\-\+\(\)]{7,}/);
                if (matchNumero) sessao.numeroInformado = matchNumero[0].replace(/[\s\-]/g, '').trim();
            }
        }

        // --- Reset de saldo inativo (5 dias) ---
        const agoraMs = Date.now();
        if (ultimaInteracao[sender] && (agoraMs - ultimaInteracao[sender]) > 5 * 24 * 60 * 60 * 1000) {
            saldosUFSC[sender] = 0;
        }
        ultimaInteracao[sender] = agoraMs;

        // --- Contagem de Estatísticas ---
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

        // --- COMANDOS PV ---
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

        // --- Verificação do Jogo de Anagrama ---
        if (anagramaGame.ativo && anagramaGame.jid === jid && body.toLowerCase() === anagramaGame.palavra) {
            saldosUFSC[sender] = (saldosUFSC[sender] || 0) + 1;
            await sock.sendMessage(jid, { text: `🎉 *ACERTOU!* @${sender.split('@')[0]} ganhou 1 UFSC! 💰 Saldo: ${saldosUFSC[sender]}`, mentions: [sender] });
            const novo = gerarAnagrama();
            anagramaGame.palavra = novo.original; anagramaGame.embaralhada = novo.embaralhada;
            return sock.sendMessage(jid, { text: `🧩 *${anagramaGame.embaralhada}*` });
        }

        // --- Punição de Mutados ---
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

        // --- Validação de Administrador ---
        let isSenderAdmin = (sender === DONO_SUPREMO || sender === DONO_ADMIN);
        if (!isSenderAdmin) {
            try {
                const meta = await sock.groupMetadata(jid);
                isSenderAdmin = meta.participants.filter(p => p.admin).map(p => p.id).includes(sender);
            } catch {}
        }

        // --- Chamada geral ---
        if (body.includes('@name') && isSenderAdmin) {
            const meta = await sock.groupMetadata(jid);
            await sock.sendMessage(jid, { text: `📢 *Chamada Geral!*`, mentions: meta.participants.map(p => p.id) });
        }

        // --- Seleção de Horário no Plantão de Triagem ---
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

        // ============================================================
        // SWITCH DE COMANDOS COMPLETO
        // ============================================================
        switch (command) {
            case 'registrar': {
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas administradores.' }, { quoted: m });
                const tokenEntrado = args[0];
                if (!senhaRegistro || tokenEntrado !== senhaRegistro) {
                    return sock.sendMessage(jid, { text: '❌ Senha de registro inválida ou expirada. Gere uma nova senha no painel Web.' }, { quoted: m });
                }
                if (!gruposRegistrados.includes(jid)) {
                    gruposRegistrados.push(jid);
                    senhaRegistro = null; 
                    await syncEstadoBotToGithub();
                    await sock.sendMessage(jid, { text: '✅ Bot registrado com sucesso neste grupo!' }, { quoted: m });
                } else {
                    await sock.sendMessage(jid, { text: '⚠️ Este grupo já está registrado.' }, { quoted: m });
                }
                break;
            }

            case 'desativa_bot':
                if (!isSenderAdmin) return;
                gruposRegistrados = gruposRegistrados.filter(g => g !== jid);
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: '🛑 Bot desativado neste grupo.' }, { quoted: m });
                break;

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
                sessaoTriagemResponsavel = null;
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: '🔒 Triagem desativada.' }, { quoted: m });
                break;

            case 'ativar_fila':
                if (!isSenderAdmin) return;
                filaAtiva = true;
                filaPendente.length = 0;
                filaEmAnalise = null;
                contadorTicket = 0;
                await sock.sendMessage(jid, { text: '🔢 *FILA SEQUENCIAL ATIVADA!*\n\nAs triagens serão enviadas 1 por vez.\nUse *.aprovar* ou *.reprovar* para avançar.' }, { quoted: m });
                break;

            case 'desativar_fila':
                if (!isSenderAdmin) return;
                filaAtiva = false;
                filaPendente.length = 0;
                filaEmAnalise = null;
                await sock.sendMessage(jid, { text: '⏹️ *FILA SEQUENCIAL DESATIVADA!*' }, { quoted: m });
                break;

            case 'registrar_link': {
                if (!isSenderAdmin) return;
                const link = args[0];
                if (!link || !link.includes('chat.whatsapp.com')) return sock.sendMessage(jid, { text: '❌ Forneça um link válido do WhatsApp.' }, { quoted: m });
                linkGrupoTriagem = link;
                await sock.sendMessage(jid, { text: `✅ Link registrado:\n${linkGrupoTriagem}` }, { quoted: m });
                break;
            }

            case 'registrar_adm': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                const apelido = args[1];
                const senhaRaw = args[2];
                if (!alvo || !apelido || !senhaRaw) return sock.sendMessage(jid, { text: '❌ Uso: *.registrar_adm @usuario apelido senha*' }, { quoted: m });

                adminsTriagem[alvo] = {
                    apelido,
                    senhaHash: hashSenha(senhaRaw),
                    triagensRealizadas: 0,
                    horarioMarcado: null,
                    _aguardandoEscolha: false
                };

                await sock.sendMessage(jid, { text: `✅ Adm de Triagem cadastrado!\n👤 @${alvo.split('@')[0]}\n🏷️ Apelido: *${apelido}*`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'login_triagem': {
                const senhaDigitada = args[0];
                if (!senhaDigitada) return sock.sendMessage(jid, { text: '❌ Informe sua senha: *.login_triagem <sua_senha>*' }, { quoted: m });

                const dadosAdm = adminsTriagem[sender];
                if (!dadosAdm) return sock.sendMessage(jid, { text: '❌ Você não está cadastrado como Adm de Triagem.' }, { quoted: m });

                if (hashSenha(senhaDigitada) !== dadosAdm.senhaHash) {
                    return sock.sendMessage(jid, { text: '❌ Senha incorreta!' }, { quoted: m });
                }

                const slots = gerarHorariosDisponiveis();
                dadosAdm._slotsDisponiveis = slots;
                dadosAdm._aguardandoEscolha = true;

                let txt = `🔓 *LOGIN CONFIRMADO - ${dadosAdm.apelido}*\n\nSelecione seu horário de plantão respondendo com o número:\n\n`;
                slots.forEach((s, idx) => { txt += `*${idx + 1}* - ${s}\n`; });

                await sock.sendMessage(jid, { text: txt }, { quoted: m });
                break;
            }

            case 'aprovar': {
                if (!isSenderAdmin) return;
                const ticketNum = parseInt(args[0]);

                if (filaAtiva && filaEmAnalise) {
                    if (ticketNum && filaEmAnalise.ticket !== ticketNum) {
                        return sock.sendMessage(jid, { text: `⚠️ O ticket em análise no momento é o *#${filaEmAnalise.ticket}*.` }, { quoted: m });
                    }

                    if (sessaoTriagemResponsavel && sender !== sessaoTriagemResponsavel && sender !== DONO_SUPREMO) {
                        const respApelido = adminsTriagem[sessaoTriagemResponsavel]?.apelido || 'outro adm';
                        return sock.sendMessage(jid, { text: `⛔ Apenas *${respApelido}* (responsável pelo plantão) pode aprovar/reprovar agora.` }, { quoted: m });
                    }

                    const alvoJid = filaEmAnalise.senderJid;
                    if (adminsTriagem[sender]) adminsTriagem[sender].triagensRealizadas++;

                    const msgAprovado = linkGrupoTriagem
                        ? `🎉 *PARABÉNS! SUAS FOTOS / AUDIOS FORAM APROVADOS!*\n\nEntre no grupo através do link abaixo:\n${linkGrupoTriagem}`
                        : `🎉 *PARABÉNS! SUAS FOTOS / AUDIOS FORAM APROVADOS!*`;

                    try { await sock.sendMessage(alvoJid, { text: msgAprovado }); } catch {}

                    await sock.sendMessage(jid, { text: `✅ Ticket *#${filaEmAnalise.ticket}* (${filaEmAnalise.numeroExibir}) APROVADO com sucesso!` });

                    filaEmAnalise = null;
                    await enviarProximaTriagemAoGrupo(sock);
                    return;
                }

                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque o usuário ou use com o número do ticket da fila.' }, { quoted: m });

                if (adminsTriagem[sender]) adminsTriagem[sender].triagensRealizadas++;
                const msgAprovadoDirect = linkGrupoTriagem
                    ? `🎉 *PARABÉNS! SUAS FOTOS / AUDIOS FORAM APROVADOS!*\n\nEntre no grupo através do link abaixo:\n${linkGrupoTriagem}`
                    : `🎉 *PARABÉNS! SUAS FOTOS / AUDIOS FORAM APROVADOS!*`;

                try { await sock.sendMessage(alvo, { text: msgAprovadoDirect }); } catch {}
                await sock.sendMessage(jid, { text: `✅ @${alvo.split('@')[0]} APROVADO(A)!`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'reprovar': {
                if (!isSenderAdmin) return;
                const ticketNumRep = parseInt(args[0]);

                if (filaAtiva && filaEmAnalise) {
                    if (ticketNumRep && filaEmAnalise.ticket !== ticketNumRep) {
                        return sock.sendMessage(jid, { text: `⚠️ O ticket em análise no momento é o *#${filaEmAnalise.ticket}*.` }, { quoted: m });
                    }

                    if (sessaoTriagemResponsavel && sender !== sessaoTriagemResponsavel && sender !== DONO_SUPREMO) {
                        const respApelido = adminsTriagem[sessaoTriagemResponsavel]?.apelido || 'outro adm';
                        return sock.sendMessage(jid, { text: `⛔ Apenas *${respApelido}* (responsável pelo plantão) pode aprovar/reprovar agora.` }, { quoted: m });
                    }

                    const alvoJid = filaEmAnalise.senderJid;
                    if (adminsTriagem[sender]) adminsTriagem[sender].triagensRealizadas++;

                    try {
                        await sock.sendMessage(alvoJid, {
                            text: `❌ *SUA TRIAGEM FOI REPROVADA.*\n\nSeus prints ou áudios não atingiram os requisitos necessários.`
                        });
                    } catch {}

                    await sock.sendMessage(jid, { text: `❌ Ticket *#${filaEmAnalise.ticket}* (${filaEmAnalise.numeroExibir}) REPROVADO.` });

                    filaEmAnalise = null;
                    await enviarProximaTriagemAoGrupo(sock);
                    return;
                }

                const alvoRep = getMention();
                if (!alvoRep) return sock.sendMessage(jid, { text: '❌ Marque o usuário ou use com o número do ticket da fila.' }, { quoted: m });

                if (adminsTriagem[sender]) adminsTriagem[sender].triagensRealizadas++;
                try {
                    await sock.sendMessage(alvoRep, {
                        text: `❌ *SUA TRIAGEM FOI REPROVADA.*\n\nSeus prints ou áudios não atingiram os requisitos necessários.`
                    });
                } catch {}
                await sock.sendMessage(jid, { text: `❌ @${alvoRep.split('@')[0]} REPROVADO(A).`, mentions: [alvoRep] }, { quoted: m });
                break;
            }

            case 'metas': {
                if (!isSenderAdmin) return;
                let txt = `📊 *PAINEL DE METAS DE TRIAGEM*\n🎯 Meta atual: *${metaTriagens} triagens*\n\n`;
                const admsList = Object.entries(adminsTriagem);

                if (!admsList.length) {
                    txt += `_Nenhum adm cadastrado ainda. Use .registrar_adm_`;
                } else {
                    admsList.forEach(([jidAdm, dados]) => {
                        const pct = Math.min(100, Math.round((dados.triagensRealizadas / metaTriagens) * 100));
                        const barra = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
                        const statusPlantao = sessaoTriagemResponsavel === jidAdm ? '🟢 [EM PLANTÃO]' : '';
                        txt += `👔 *${dados.apelido}* ${statusPlantao}\n`;
                        txt += `   └ Realizadas: *${dados.triagensRealizadas}/${metaTriagens}* [${barra}] ${pct}%\n`;
                        if (dados.horarioMarcado) txt += `   └ Horário: ${dados.horarioMarcado}\n`;
                    });
                }
                await sock.sendMessage(jid, { text: txt }, { quoted: m });
                break;
            }

            case 'alterar_meta': {
                if (!isSenderAdmin) return;
                const novaMeta = parseInt(args[0]);
                if (isNaN(novaMeta) || novaMeta <= 0) return sock.sendMessage(jid, { text: '❌ Forneça um número válido maior que 0.' }, { quoted: m });
                metaTriagens = novaMeta;
                await sock.sendMessage(jid, { text: `✅ Meta atualizada para *${metaTriagens}* triagens por adm.` }, { quoted: m });
                break;
            }

            case 's':
            case 'figurinha':
            case 'a': {
                const isAnim = command === 'a';
                const cost   = isAnim ? precoFigurinha * 2 : precoFigurinha;
                const saldo  = saldosUFSC[sender] || 0;

                if (saldo < cost && sender !== DONO_SUPREMO) {
                    return sock.sendMessage(jid, { text: `❌ Saldo insuficiente. Custa ${cost} UFSC. Seu saldo: ${saldo}` }, { quoted: m });
                }

                const msgComMidia = m.message.extendedTextMessage?.contextInfo?.quotedMessage || m.message;
                const media = await baixarMidiaDoMensagem(sock, msgComMidia);

                if (!media || (media.tipo !== 'image' && media.tipo !== 'video')) {
                    return sock.sendMessage(jid, { text: '❌ Marque ou envie uma imagem/vídeo curto.' }, { quoted: m });
                }

                try {
                    const sticker = new Sticker(media.buffer, {
                        pack: 'Atrino Bot', author: 'Atrino',
                        type: StickerTypes.FULL, quality: 70
                    });
                    const buf = await sticker.toBuffer();
                    if (sender !== DONO_SUPREMO) saldosUFSC[sender] -= cost;
                    await sock.sendMessage(jid, { sticker: buf }, { quoted: m });
                } catch (err) {
                    await sock.sendMessage(jid, { text: '❌ Erro ao criar figurinha.' }, { quoted: m });
                }
                break;
            }

            case 'mat':
            case 'match': {
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque alguém.' }, { quoted: m });
                const pct = Math.floor(Math.random() * 101);
                await sock.sendMessage(jid, {
                    text: `💘 *MATCH DETECTOR*\n\n@${sender.split('@')[0]} + @${alvo.split('@')[0]}\n\nCompatibilidade: *${pct}%*`,
                    mentions: [sender, alvo]
                }, { quoted: m });
                break;
            }

            case 'cep': {
                const cepInput = args[0]?.replace(/\D/g, '');
                if (!cepInput || cepInput.length !== 8) return sock.sendMessage(jid, { text: '❌ CEP inválido. Use 8 dígitos.' }, { quoted: m });
                try {
                    const res = await axios.get(`https://viacep.com.br/ws/${cepInput}/json/`);
                    if (res.data.erro) return sock.sendMessage(jid, { text: '❌ CEP não encontrado.' }, { quoted: m });
                    const d = res.data;
                    await sock.sendMessage(jid, { text: `📍 *CONSULTA CEP*\n\n🏠 Logradouro: ${d.logradouro}\n🏡 Bairro: ${d.bairro}\n🏙️ Cidade: ${d.localidade} - ${d.uf}\n📮 CEP: ${d.cep}` }, { quoted: m });
                } catch {
                    await sock.sendMessage(jid, { text: '❌ Erro na consulta.' }, { quoted: m });
                }
                break;
            }

            case 'contador':
                if (!isSenderAdmin) return;
                contagemAtiva[jid] = !contagemAtiva[jid];
                await sock.sendMessage(jid, { text: contagemAtiva[jid] ? '📊 Contagem de mensagens ATIVADA.' : '📊 Contagem DESATIVADA.' }, { quoted: m });
                break;

            case 'doar': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                const valor = parseInt(args[1] || args[0]);
                if (!alvo || isNaN(valor)) return sock.sendMessage(jid, { text: '❌ Uso: *.doar @user 10*' }, { quoted: m });
                saldosUFSC[alvo] = (saldosUFSC[alvo] || 0) + valor;
                await sock.sendMessage(jid, { text: `💰 Doado ${valor} UFSC para @${alvo.split('@')[0]}. Novo saldo: ${saldosUFSC[alvo]}`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'id':
                await sock.sendMessage(jid, { text: `🆔 ID do Grupo:\n\`${jid}\`` }, { quoted: m });
                break;

            case 'ranking': {
                if (!estatisticas[jid]) return sock.sendMessage(jid, { text: '📊 Nenhuma estatística registrada.' }, { quoted: m });
                const ordenado = Object.entries(estatisticas[jid]).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
                let txt = '🏆 *TOP 10 MAIS ATIVOS*\n\n';
                const ment = [];
                ordenado.forEach(([uid, st], idx) => {
                    txt += `${idx + 1}. @${uid.split('@')[0]} — *${st.total}* msgs\n`;
                    ment.push(uid);
                });
                await sock.sendMessage(jid, { text: txt, mentions: ment }, { quoted: m });
                break;
            }

            case 'ativar_anagrama':
                if (!isSenderAdmin) return;
                if (anagramaGame.ativo) return sock.sendMessage(jid, { text: '⚠️ Já existe um jogo em andamento.' }, { quoted: m });
                const novo = gerarAnagrama();
                anagramaGame = { ativo: true, palavra: novo.original, embaralhada: novo.embaralhada, jid };
                await sock.sendMessage(jid, { text: `🎮 *JOGO DO ANAGRAMA INICIADO!*\n\nDescubra a palavra:\n🧩 *${anagramaGame.embaralhada}*\n\nQuem acertar primeiro ganha 1 UFSC!` });
                break;

            case 'desativa_anagrama':
                if (!isSenderAdmin) return;
                anagramaGame = { ativo: false, palavra: '', embaralhada: '', jid: '' };
                await sock.sendMessage(jid, { text: '🛑 Anagrama desativado.' }, { quoted: m });
                break;

            case 'notificar':
                if (!isSenderAdmin) return;
                notificacoesAtivas[jid] = true;
                await sock.sendMessage(jid, { text: '🔔 Boas-vindas ativadas.' }, { quoted: m });
                break;

            case 'naonotificar':
                if (!isSenderAdmin) return;
                notificacoesAtivas[jid] = false;
                await sock.sendMessage(jid, { text: '🔕 Boas-vindas desativadas.' }, { quoted: m });
                break;

            case 'alert_tiktok': {
                if (!isSenderAdmin) return;
                const userTk = args[0]?.replace('@', '');
                if (!userTk) return sock.sendMessage(jid, { text: '❌ Informe o username do TikTok.' }, { quoted: m });
                alertasTikTok[jid] = { username: userTk, ultimoVideoId: null };
                await sock.sendMessage(jid, { text: `🎵 Alerta ativado para *@${userTk}* neste grupo!` }, { quoted: m });
                break;
            }

            case 'remover_alert_tiktok':
                if (!isSenderAdmin) return;
                delete alertasTikTok[jid];
                await sock.sendMessage(jid, { text: '🛑 Alertas do TikTok removidos.' }, { quoted: m });
                break;

            case 'tornaadm': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque alguém.' }, { quoted: m });
                await sock.groupParticipantsUpdate(jid, [alvo], 'promote');
                await sock.sendMessage(jid, { text: `👑 @${alvo.split('@')[0]} promovido a admin!`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'rebaixar': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque alguém.' }, { quoted: m });
                await sock.groupParticipantsUpdate(jid, [alvo], 'demote');
                await sock.sendMessage(jid, { text: `📉 @${alvo.split('@')[0]} rebaixado.`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'totag': {
                if (!isSenderAdmin) return;
                const meta = await sock.groupMetadata(jid);
                const txt = args.join(' ') || '📢 *Atenção todos!*';
                await sock.sendMessage(jid, { text: txt, mentions: meta.participants.map(p => p.id) });
                break;
            }

            case 'adv': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque alguém.' }, { quoted: m });
                advertencias[alvo] = (advertencias[alvo] || 0) + 1;
                if (advertencias[alvo] >= 3) {
                    await sock.sendMessage(jid, { text: `🚫 @${alvo.split('@')[0]} atingiu 3/3 advs. Removido.`, mentions: [alvo] });
                    await sock.groupParticipantsUpdate(jid, [alvo], 'remove');
                    delete advertencias[alvo];
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ @${alvo.split('@')[0]} recebeu advertência! Total: ${advertencias[alvo]}/3`, mentions: [alvo] });
                }
                break;
            }

            case 'unadv': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque alguém.' }, { quoted: m });
                if (advertencias[alvo]) {
                    advertencias[alvo]--;
                    await sock.sendMessage(jid, { text: `✅ Adv removida de @${alvo.split('@')[0]}. Restantes: ${advertencias[alvo]}/3`, mentions: [alvo] });
                } else {
                    await sock.sendMessage(jid, { text: '⚠️ Usuário não tem advertências.' }, { quoted: m });
                }
                break;
            }

            case 'mute': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque alguém.' }, { quoted: m });
                if (!mutados.includes(alvo)) mutados.push(alvo);
                await sock.sendMessage(jid, { text: `🔇 @${alvo.split('@')[0]} mutado.`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'desmute': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque alguém.' }, { quoted: m });
                mutados = mutados.filter(x => x !== alvo);
                await sock.sendMessage(jid, { text: `🔊 @${alvo.split('@')[0]} desmutado.`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'abrir':
                if (!isSenderAdmin) return;
                await sock.groupSettingUpdate(jid, 'not_announcement');
                await sock.sendMessage(jid, { text: '🔓 Grupo aberto para todos os membros.' }, { quoted: m });
                break;

            case 'fechar':
                if (!isSenderAdmin) return;
                await sock.groupSettingUpdate(jid, 'announcement');
                await sock.sendMessage(jid, { text: '🔒 Grupo fechado (apenas admins falam).' }, { quoted: m });
                break;

            case 'ban': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque alguém.' }, { quoted: m });
                await sock.groupParticipantsUpdate(jid, [alvo], 'remove');
                await sock.sendMessage(jid, { text: `🚫 @${alvo.split('@')[0]} removido do grupo.`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'aceitar': {
                if (!isSenderAdmin) return;
                const sol = solicitacoesPendentes[jid];
                if (!sol) return sock.sendMessage(jid, { text: '⚠️ Nenhuma solicitação pendente.' }, { quoted: m });
                await sock.groupRequestParticipantsUpdate(jid, [sol], 'approve');
                delete solicitacoesPendentes[jid];
                await sock.sendMessage(jid, { text: '✅ Entrada aprovada!' }, { quoted: m });
                break;
            }

            case 'recusar': {
                if (!isSenderAdmin) return;
                const sol = solicitacoesPendentes[jid];
                if (!sol) return sock.sendMessage(jid, { text: '⚠️ Nenhuma solicitação pendente.' }, { quoted: m });
                await sock.groupRequestParticipantsUpdate(jid, [sol], 'reject');
                delete solicitacoesPendentes[jid];
                await sock.sendMessage(jid, { text: '❌ Entrada recusada.' }, { quoted: m });
                break;
            }

            case 'relatorio': {
                if (!isSenderAdmin) return;
                let txt = '📜 *HISTÓRICO DE ÚLTIMOS COMANDOS*\n\n';
                historicoComandos.slice(-15).forEach(h => {
                    txt += `🔹 .${h.comando} por @${h.usuario.split('@')[0]} [${h.horario}]\n`;
                });
                const ment = historicoComandos.slice(-15).map(h => h.usuario);
                await sock.sendMessage(jid, { text: txt, mentions: ment }, { quoted: m });
                break;
            }

            default:
                break;
        }
    });
}

// Inicia a execução do bot
startAtrinoBot();
