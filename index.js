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
const adminsTriagem          = {};
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

    // --- CONEXÃO E TRATAMENTO DE ERROS ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrAtual = qr;
            console.log('\n🔗 QR: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr));
            qrcode.generate(qr, { small: false });
        }

        if (connection === 'open') {
            qrAtual = null;
            console.log('\n✅ ATRINO BOT ONLINE E CONECTADO COM SUCESSO!\n');
        }

        if (connection === 'close') {
            qrAtual = null;
            const error = lastDisconnect?.error;
            const statusCode = new Boom(error)?.output?.statusCode;

            console.log(`❌ Conexão fechada. Motivo / StatusCode: ${statusCode}`);
            if (error) console.log('Detalhes do erro:', error);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log('⚠️ Sessão encerrada ou inválida. Limpando auth_info para permitir novo QR...');
                if (fs.existsSync('auth_info')) {
                    fs.rmSync('auth_info', { recursive: true, force: true });
                }
                setTimeout(() => startAtrinoBot(), 5000);
            } else {
                console.log('🔄 Tentando reconectar em 5 segundos...');
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
            // TRIAGEM — ATIVAR / DESATIVAR
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
                if (!args[0]) return sock.sendMessage(jid, { text: '❌ Envie o link do grupo. Ex: .registrar_link https://chat.whatsapp.com/...' }, { quoted: m });
                linkGrupoTriagem = args[0].trim();
                await sock.sendMessage(jid, { text: `✅ Link registrado com sucesso:\n${linkGrupoTriagem}` }, { quoted: m });
                break;

            // --------------------------------------------------------
            // SISTEMA DE ADMINS DE TRIAGEM
            // --------------------------------------------------------
            case 'registrar_adm': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque o membro. Ex: .registrar_adm @user apelido senha' }, { quoted: m });
                const apelido = args[1];
                const senha   = args[2];
                if (!apelido || !senha) return sock.sendMessage(jid, { text: '❌ Informe apelido e senha. Ex: .registrar_adm @user Pedro 1234' }, { quoted: m });

                adminsTriagem[alvo] = {
                    apelido,
                    senhaHash: hashSenha(senha),
                    loginAtivo: false,
                    horarioMarcado: null,
                    triagemFeitas: 0,
                    aprovacoes: 0,
                    reprovacoes: 0
                };
                await sock.sendMessage(jid, { text: `✅ Adm de triagem cadastrado com sucesso!\n\n👤 Nome: ${apelido}\n📲 JID: ${alvo.split('@')[0]}` }, { quoted: m });
                break;
            }

            case 'login_triagem': {
                const dadosAdm = adminsTriagem[sender];
                if (!dadosAdm) return sock.sendMessage(jid, { text: '❌ Você não está cadastrado como admin de triagem.' }, { quoted: m });
                const senhaDigitada = args[0];
                if (!senhaDigitada || hashSenha(senhaDigitada) !== dadosAdm.senhaHash) {
                    return sock.sendMessage(jid, { text: '❌ Senha incorreta.' }, { quoted: m });
                }

                dadosAdm.loginAtivo = true;
                const slots = gerarHorariosDisponiveis();
                dadosAdm._slotsDisponiveis = slots;
                dadosAdm._aguardandoEscolha = true;

                let msgSlots = `✅ *Login efetuado com sucesso, ${dadosAdm.apelido}!*\n\nEscolha o horário do seu plantão (responda com o número):\n\n`;
                slots.forEach((s, idx) => { msgSlots += `${idx + 1}️⃣ ${s}\n`; });
                await sock.sendMessage(jid, { text: msgSlots }, { quoted: m });
                break;
            }

            case 'aprovar': {
                if (!isSenderAdmin && !adminsTriagem[sender]?.loginAtivo) return sock.sendMessage(jid, { text: '❌ Apenas admins logados podem aprovar.' }, { quoted: m });
                const numTicket = parseInt(args[0]);
                if (!numTicket) return sock.sendMessage(jid, { text: '❌ Informe o ticket. Ex: .aprovar 1' }, { quoted: m });

                if (!filaEmAnalise || filaEmAnalise.ticket !== numTicket) {
                    return sock.sendMessage(jid, { text: `⚠️ O ticket #${numTicket} não está atualmente em análise.` }, { quoted: m });
                }

                const candJid = filaEmAnalise.senderJid;
                const msgLink = linkGrupoTriagem ? `\n\n🔗 *Entre pelo link:* ${linkGrupoTriagem}` : '';

                try {
                    await sock.sendMessage(candJid, {
                        text: `🎉 *PARABÉNS! SUA TRIAGEM FOI APROVADA!* 🎉\n\nVocê foi aceito(a) no grupo!${msgLink}`
                    });
                } catch {}

                if (adminsTriagem[sender]) {
                    adminsTriagem[sender].triagemFeitas++;
                    adminsTriagem[sender].aprovacoes++;
                }

                await sock.sendMessage(jid, { text: `✅ *Ticket #${numTicket} APROVADO!* Candidato notificado.` }, { quoted: m });
                filaEmAnalise = null;
                await enviarProximaTriagemAoGrupo(sock);
                break;
            }

            case 'reprovar': {
                if (!isSenderAdmin && !adminsTriagem[sender]?.loginAtivo) return sock.sendMessage(jid, { text: '❌ Apenas admins logados podem reprovar.' }, { quoted: m });
                const numTicket = parseInt(args[0]);
                if (!numTicket) return sock.sendMessage(jid, { text: '❌ Informe o ticket. Ex: .reprovar 1' }, { quoted: m });

                if (!filaEmAnalise || filaEmAnalise.ticket !== numTicket) {
                    return sock.sendMessage(jid, { text: `⚠️ O ticket #${numTicket} não está atualmente em análise.` }, { quoted: m });
                }

                const candJid = filaEmAnalise.senderJid;
                try {
                    await sock.sendMessage(candJid, {
                        text: `❌ *TRIAGEM NÃO APROVADA*\n\nSua triagem foi analisada e infelizmente você não atendeu aos requisitos necessários.`
                    });
                } catch {}

                if (adminsTriagem[sender]) {
                    adminsTriagem[sender].triagemFeitas++;
                    adminsTriagem[sender].reprovacoes++;
                }

                await sock.sendMessage(jid, { text: `🔴 *Ticket #${numTicket} REPROVADO.* Candidato notificado.` }, { quoted: m });
                filaEmAnalise = null;
                await enviarProximaTriagemAoGrupo(sock);
                break;
            }

            case 'metas': {
                if (!isSenderAdmin) return;
                let txtMetas = `📊 *PAINEL DE METAS DOS ADMINS*\n🎯 Meta por sessão: *${metaTriagens} triagens*\n\n`;
                const listaAdms = Object.entries(adminsTriagem);

                if (!listaAdms.length) {
                    txtMetas += 'Nenhum adm cadastrado no sistema.';
                } else {
                    for (const [aJid, aData] of listaAdms) {
                        const progresso = aData.triagemFeitas;
                        const pct = Math.min(100, Math.round((progresso / metaTriagens) * 100));
                        const statusMeta = progresso >= metaTriagens ? '✅ Concluída' : '⏳ Em andamento';
                        txtMetas += `👔 *${aData.apelido}* (@${aJid.split('@')[0]})\n`;
                        txtMetas += `├ Realizadas: ${progresso}/${metaTriagens} (${pct}%)\n`;
                        txtMetas += `├ Aprovadas: ${aData.aprovacoes} | Reprovadas: ${aData.reprovacoes}\n`;
                        txtMetas += `└ Status: ${statusMeta}\n\n`;
                    }
                }
                const mJids = listaAdms.map(([j]) => j);
                await sock.sendMessage(jid, { text: txtMetas, mentions: mJids }, { quoted: m });
                break;
            }

            case 'alterar_meta': {
                if (!isSenderAdmin) return;
                const novaMeta = parseInt(args[0]);
                if (isNaN(novaMeta) || novaMeta <= 0) return sock.sendMessage(jid, { text: '❌ Valor inválido. Ex: .alterar_meta 15' }, { quoted: m });
                metaTriagens = novaMeta;
                await sock.sendMessage(jid, { text: `✅ Meta de triagens alterada para *${metaTriagens}* por sessão!` }, { quoted: m });
                break;
            }

            // --------------------------------------------------------
            // FIGURINHAS
            // --------------------------------------------------------
            case 's':
            case 'figurinha': {
                const qMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage || m.message;
                const isImg = qMsg.imageMessage;
                const isVid = qMsg.videoMessage;

                if (!isImg && !isVid) return sock.sendMessage(jid, { text: '❌ Marque uma imagem ou vídeo curto.' }, { quoted: m });

                try {
                    const type = isImg ? 'image' : 'video';
                    const target = isImg ? qMsg.imageMessage : qMsg.videoMessage;
                    const stream = await downloadContentFromMessage(target, type);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                    const sticker = new Sticker(buffer, {
                        pack: 'Atrino Bot',
                        author: 'Atrino',
                        type: StickerTypes.FULL,
                        quality: 70
                    });
                    const stickerBuffer = await sticker.toBuffer();
                    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: m });
                } catch (err) {
                    console.error('[sticker]', err);
                    await sock.sendMessage(jid, { text: '❌ Falha ao gerar a figurinha.' }, { quoted: m });
                }
                break;
            }

            // --------------------------------------------------------
            // UTILITÁRIOS E GERENCIAMENTO DE GRUPO
            // --------------------------------------------------------
            case 'cep': {
                const cepInput = args[0]?.replace(/\D/g, '');
                if (!cepInput || cepInput.length !== 8) return sock.sendMessage(jid, { text: '❌ Informe um CEP válido de 8 dígitos. Ex: .cep 01001000' }, { quoted: m });
                try {
                    const { data } = await axios.get(`https://viacep.com.br/ws/${cepInput}/json/`);
                    if (data.erro) return sock.sendMessage(jid, { text: '❌ CEP não encontrado.' }, { quoted: m });
                    await sock.sendMessage(jid, {
                        text: `📍 *BUSCA CEP*\n\n🏡 Logradouro: ${data.logradouro}\n🏙️ Bairro: ${data.bairro}\n🌆 Cidade/UF: ${data.localidade}/${data.uf}\n📮 CEP: ${data.cep}`
                    }, { quoted: m });
                } catch {
                    await sock.sendMessage(jid, { text: '❌ Erro ao buscar CEP.' }, { quoted: m });
                }
                break;
            }

            case 'contador':
                if (!isSenderAdmin) return;
                contagemAtiva[jid] = !contagemAtiva[jid];
                await sock.sendMessage(jid, { text: contagemAtiva[jid] ? '✅ Contagem de atividade ativada!' : '🔴 Contagem de atividade desativada.' }, { quoted: m });
                break;

            case 'ranking': {
                if (!estatisticas[jid]) return sock.sendMessage(jid, { text: '📊 Nenhuma estatística registrada ainda.' }, { quoted: m });
                const ordenado = Object.entries(estatisticas[jid]).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
                let textRank = `🏆 *RANKING DE ATIVIDADE*\n\n`;
                const rankMentions = [];
                ordenado.forEach(([uJid, data], index) => {
                    rankMentions.push(uJid);
                    textRank += `${index + 1}º @${uJid.split('@')[0]} - ${data.total} mensagens\n`;
                });
                await sock.sendMessage(jid, { text: textRank, mentions: rankMentions }, { quoted: m });
                break;
            }

            case 'doar': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                const valor = parseInt(args[1]);
                if (!alvo || isNaN(valor)) return sock.sendMessage(jid, { text: '❌ Ex: .doar @membro 100' }, { quoted: m });
                saldosUFSC[alvo] = (saldosUFSC[alvo] || 0) + valor;
                await sock.sendMessage(jid, { text: `💰 Adicionados *${valor} UFSC* para @${alvo.split('@')[0]}! Saldo: ${saldosUFSC[alvo]}`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'id':
                await sock.sendMessage(jid, { text: `🆔 ID do Chat: \`${jid}\`` }, { quoted: m });
                break;

            case 'ativar_anagrama':
                if (!isSenderAdmin) return;
                const anag = gerarAnagrama();
                anagramaGame = { ativo: true, palavra: anag.original, embaralhada: anag.embaralhada, jid };
                await sock.sendMessage(jid, { text: `🎮 *ANAGRAMA ATIVADO!*\n\nDescubra a palavra: *${anagramaGame.embaralhada}*` }, { quoted: m });
                break;

            case 'desativa_anagrama':
                if (!isSenderAdmin) return;
                anagramaGame.ativo = false;
                await sock.sendMessage(jid, { text: '🔴 Anagrama desativado.' }, { quoted: m });
                break;

            case 'notificar':
                if (!isSenderAdmin) return;
                notificacoesAtivas[jid] = true;
                await sock.sendMessage(jid, { text: '✅ Notificações e Boas-Vindas ativadas para este grupo.' }, { quoted: m });
                break;

            case 'naonotificar':
                if (!isSenderAdmin) return;
                notificacoesAtivas[jid] = false;
                await sock.sendMessage(jid, { text: '🔴 Notificações e Boas-Vindas desativadas.' }, { quoted: m });
                break;

            case 'alert_tiktok': {
                if (!isSenderAdmin) return;
                const targetUser = args[0]?.replace('@', '');
                if (!targetUser) return sock.sendMessage(jid, { text: '❌ Informe o usuário do TikTok. Ex: .alert_tiktok nome_usuario' }, { quoted: m });
                alertasTikTok[jid] = { username: targetUser, ultimoVideoId: null };
                await sock.sendMessage(jid, { text: `✅ Alerta do TikTok configurado para *@${targetUser}* neste grupo!` }, { quoted: m });
                break;
            }

            case 'remover_alert_tiktok':
                if (!isSenderAdmin) return;
                delete alertasTikTok[jid];
                await sock.sendMessage(jid, { text: '🔴 Alerta do TikTok removido para este grupo.' }, { quoted: m });
                break;

            case 'tornaadm': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque quem deseja promover.' }, { quoted: m });
                await sock.groupParticipantsUpdate(jid, [alvo], 'promote');
                await sock.sendMessage(jid, { text: `✅ @${alvo.split('@')[0]} promovido a admin!`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'rebaixar': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque quem deseja rebaixar.' }, { quoted: m });
                await sock.groupParticipantsUpdate(jid, [alvo], 'demote');
                await sock.sendMessage(jid, { text: `🔴 @${alvo.split('@')[0]} rebaixado!`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'totag': {
                if (!isSenderAdmin) return;
                const meta = await sock.groupMetadata(jid);
                const todos = meta.participants.map(p => p.id);
                const msgTag = args.join(' ') || '📢 Chamada de Atenção!';
                await sock.sendMessage(jid, { text: msgTag, mentions: todos });
                break;
            }

            case 'adv': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque quem deseja advertir.' }, { quoted: m });
                advertencias[alvo] = (advertencias[alvo] || 0) + 1;
                await sock.sendMessage(jid, { text: `⚠️ @${alvo.split('@')[0]} recebeu uma advertência (${advertencias[alvo]}/3).`, mentions: [alvo] }, { quoted: m });
                if (advertencias[alvo] >= 3) {
                    await sock.groupParticipantsUpdate(jid, [alvo], 'remove');
                    delete advertencias[alvo];
                }
                break;
            }

            case 'unadv': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque o membro.' }, { quoted: m });
                if (advertencias[alvo]) {
                    advertencias[alvo]--;
                    await sock.sendMessage(jid, { text: `✅ Advertência removida. Atual: (${advertencias[alvo]}/3)`, mentions: [alvo] }, { quoted: m });
                }
                break;
            }

            case 'mute': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque o membro a ser mutado.' }, { quoted: m });
                if (!mutados.includes(alvo)) mutados.push(alvo);
                await sock.sendMessage(jid, { text: `🔇 @${alvo.split('@')[0]} foi mutado.`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'desmute': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque o membro a ser desmutado.' }, { quoted: m });
                mutados = mutados.filter(x => x !== alvo);
                await sock.sendMessage(jid, { text: `🔊 @${alvo.split('@')[0]} foi desmutado.`, mentions: [alvo] }, { quoted: m });
                break;
            }

            case 'ban': {
                if (!isSenderAdmin) return;
                const alvo = getMention();
                if (!alvo) return sock.sendMessage(jid, { text: '❌ Marque quem deseja banir.' }, { quoted: m });
                await sock.groupParticipantsUpdate(jid, [alvo], 'remove');
                await sock.sendMessage(jid, { text: `🚫 @${alvo.split('@')[0]} foi removido!`, mentions: [alvo] }, { quoted: m });
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
                await sock.sendMessage(jid, { text: '🔒 Grupo fechado. Apenas admins podem mandar mensagem.' }, { quoted: m });
                break;

            case 'aceitar': {
                if (!isSenderAdmin) return;
                const pendente = solicitacoesPendentes[jid];
                if (!pendente) return sock.sendMessage(jid, { text: '⚠️ Nenhuma solicitação pendente.' }, { quoted: m });
                await sock.groupRequestParticipantsUpdate(jid, [pendente], 'approve');
                delete solicitacoesPendentes[jid];
                await sock.sendMessage(jid, { text: '✅ Entrada aprovada!' }, { quoted: m });
                break;
            }

            case 'recusar': {
                if (!isSenderAdmin) return;
                const pendente = solicitacoesPendentes[jid];
                if (!pendente) return sock.sendMessage(jid, { text: '⚠️ Nenhuma solicitação pendente.' }, { quoted: m });
                await sock.groupRequestParticipantsUpdate(jid, [pendente], 'reject');
                delete solicitacoesPendentes[jid];
                await sock.sendMessage(jid, { text: '🔴 Entrada recusada.' }, { quoted: m });
                break;
            }

            case 'relatorio': {
                if (!isSenderAdmin) return;
                let rel = `📋 *HISTÓRICO DE COMANDOS RECENTES*\n\n`;
                historicoComandos.slice(-15).forEach(c => {
                    rel += `• *${c.comando}* por @${c.usuario.split('@')[0]} às ${c.horario}\n`;
                });
                await sock.sendMessage(jid, { text: rel, mentions: historicoComandos.map(c => c.usuario) }, { quoted: m });
                break;
            }

            default:
                break;
        }
    });
}

startAtrinoBot();
