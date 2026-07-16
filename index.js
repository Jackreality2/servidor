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
// filaPendente  : triagens finalizadas aguardando envio ao grupo
// filaEmAnalise : triagem atualmente visível no grupo (max 1)
// ============================================================
let filaAtiva         = false;
let linkGrupoTriagem  = null;
let contadorTicket    = 0;
const filaPendente    = [];   // { ticket, senderJid, numeroExibir, sessao }
let   filaEmAnalise   = null; // { ticket, senderJid, numeroExibir, status }

// ============================================================
// SISTEMA DE ADMINS DE TRIAGEM
// adminsTriagem: { [jidAdm]: { apelido, senhaHash, loginAtivo,
//                              horarioMarcado, triagemFeitas,
//                              aprovacoes, reprovacoes } }
// sessaoTriagemResponsavel: adm JID que está de plantão agora
// metaTriagens: quantidade alvo de triagens por sessão
// ============================================================
const adminsTriagem          = {};
let   sessaoTriagemResponsavel = null; // jid do adm de plantão
let   metaTriagens           = 10;    // padrão 10, alterável

// ============================================================
// SISTEMA DE ALERTA TIKTOK
// ============================================================
const alertasTikTok = {};

// --- hash simples para senha (sem dependência extra) ---
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
    if (filaEmAnalise) return; // já tem uma em análise, aguarda
    if (!filaPendente.length) return; // fila vazia

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

// ============================================================
// HORÁRIOS DISPONÍVEIS PARA LOGIN DE TRIAGEM
// ============================================================
function gerarHorariosDisponiveis() {
    const agora = new Date();
    const slots = [];
    // gera 6 slots de 30 em 30 min a partir da hora atual
    for (let i = 0; i < 6; i++) {
        const d = new Date(agora.getTime() + i * 30 * 60 * 1000);
        const h = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        slots.push(h);
    }
    return slots;
}

async function startAtrinoBot() {
    await loadEstadoBotFromGithub();
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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrAtual = qr;
            console.log('\n🔗 QR: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr));
            qrcode.generate(qr, { small: false });
        }
        if (connection === 'open') { qrAtual = null; console.log('\n✅ ATRINO BOT ONLINE!\n'); }
        if (connection === 'close') {
            qrAtual = null;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) { console.log('🔄 Reconectando...'); startAtrinoBot(); }
            else console.log('❌ Sessão encerrada permanentemente.');
        }
    });

    // ============================================================
    // HANDLER PRINCIPAL DE MENSAGENS
    // ============================================================
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid    = m.key.remoteJid;
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
                // .triagem
                if (pvCommand === 'triagem') {
                    if (!grupoTriagemAtivo) return sock.sendMessage(jid, { text: '⚠️ Nenhum grupo ativou a triagem no momento.' });
                    if (triagensFinalizadas.has(sender)) return sock.sendMessage(jid, { text: '❌ Você já realizou sua triagem. Não é permitido enviar mais de uma vez.' });

                    if (!sessoesTriagem[sender]) {
                        sessoesTriagem[sender] = criarSessaoTriagem(sender, grupoTriagemAtivo);

                        // EXPIRAÇÃO: 2 min sem .finalizar
                        sessoesTriagem[sender]._expiracao = setTimeout(async () => {
                            if (sessoesTriagem[sender]) {
                                delete sessoesTriagem[sender];
                                triagensFinalizadas.delete(sender); // permite tentar de novo se quiser
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

                // .finalizar
                if (pvCommand === 'finalizar') {
                    const sessao = sessoesTriagem[sender];
                    if (!sessao) return sock.sendMessage(jid, { text: '⚠️ Você ainda não iniciou uma triagem. Envie *.triagem* primeiro.' });
                    if (!grupoTriagemAtivo) { delete sessoesTriagem[sender]; return sock.sendMessage(jid, { text: '⚠️ Nenhum grupo está recebendo triagens no momento.' }); }

                    // cancela expiração
                    if (sessao._expiracao) { clearTimeout(sessao._expiracao); delete sessao._expiracao; }

                    const numeroExibir = sessao.numeroInformado || sender.split('@')[0];

                    delete sessoesTriagem[sender];
                    triagensFinalizadas.add(sender);
                    contadorTicket++;
                    const ticket = contadorTicket;

                    // adiciona à fila pendente
                    filaPendente.push({ ticket, senderJid: sender, numeroExibir, sessao });

                    const posicaoFila = filaPendente.length + (filaEmAnalise ? 1 : 0);
                    await sock.sendMessage(sender, {
                        text: `✅ Triagem enviada!\n\n🎫 *Ticket: #${ticket}*\n📊 Posição na fila: *${posicaoFila}º*\n\n⏳ Você será notificado(a) assim que sua triagem for analisada.`
                    });

                    // se não tem nenhuma em análise, envia imediatamente
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

        if (!body.startsWith('.')) return;

        const args    = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        if (!gruposRegistrados.includes(jid) && command !== 'registrar') return;

        const agoraCmd  = new Date();
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
                sessaoTriagemResponsavel = null;
                await syncEstadoBotToGithub();
                await sock.sendMessage(jid, { text: '🔒 Triagem desativada.' }, { quoted: m });
                break;

            // --------------------------------------------------------
            // FILA
            // --------------------------------------------------------
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
                await sock.sendMessage(jid, { text: '🔕 Fila desativada.' }, { quoted: m });
                break;

            case 'registrar_link':
                if (!isSenderAdmin) return;
                if (!args[0]) return sock.sendMessage(jid, { text: '❌ Uso: *.registrar_link https://chat.whatsapp.com/...*' }, { quoted: m });
                linkGrupoTriagem = args[0].trim();
                await sock.sendMessage(jid, { text: `✅ Link registrado:\n🔗 ${linkGrupoTriagem}` }, { quoted: m });
                break;

            // --------------------------------------------------------
            // ADMINS DE TRIAGEM — CADASTRO
            // .registrar_adm @mention apelido senha
            // --------------------------------------------------------
            case 'registrar_adm': {
                if (!isSenderAdmin) return;
                const alvoCadastro = getMention();
                // args[0] pode ser o @menção (já processada), args restantes: apelido senha
                // formato: .registrar_adm @jid apelido senha
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

            // --------------------------------------------------------
            // LOGIN DE TRIAGEM
            // .login_triagem senha
            // --------------------------------------------------------
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

                await sock.sendMessage(jid, {
                    text: `✅ *Login realizado!*\n\n👋 Olá, *${admDados.apelido}*!\n🕐 Horário de início: *${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}*\n\n📅 *Marque seu horário de plantão:*\n\n${slots.map((h, i) => `${i + 1}️⃣ ${h}`).join('\n')}\n\nResponda com o número da opção (1 a ${slots.length}) para marcar.`,
                    _slots: slots
                }, { quoted: m });

                // armazena slots temporariamente para capturar resposta
                admDados._slotsDisponiveis = slots;
                admDados._aguardandoEscolha = true;
                break;
            }

            // --------------------------------------------------------
            // APROVAR / REPROVAR
            // --------------------------------------------------------
            case 'aprovar': {
                if (!isSenderAdmin) return;

                // verifica se quem aprova é o adm de plantão (ou dono)
                if (sessaoTriagemResponsavel && sender !== sessaoTriagemResponsavel &&
                    sender !== DONO_SUPREMO && sender !== DONO_ADMIN) {
                    const respApelido = adminsTriagem[sessaoTriagemResponsavel]?.apelido || 'outro adm';
                    return sock.sendMessage(jid, { text: `❌ Apenas *${respApelido}* (responsável de plantão) pode aprovar/reprovar agora.` }, { quoted: m });
                }

                const ticketAprovar = parseInt(args[0]);
                if (isNaN(ticketAprovar)) return sock.sendMessage(jid, { text: '❌ Uso: *.aprovar <número>*' }, { quoted: m });
                if (!filaEmAnalise || filaEmAnalise.ticket !== ticketAprovar) {
                    return sock.sendMessage(jid, { text: `❌ Ticket #${ticketAprovar} não está em análise no momento.` }, { quoted: m });
                }

                const entrada = filaEmAnalise;
                entrada.status = 'aprovado';
                filaEmAnalise = null;

                // contabiliza meta
                if (adminsTriagem[sender]) adminsTriagem[sender].aprovacoes++;

                await sock.sendMessage(jid, { text: `✅ Ticket #${ticketAprovar} *APROVADO!*\n📱 ${entrada.numeroExibir}` }, { quoted: m });

                // notifica membro no PV
                try {
                    const responsavelApelido = sessaoTriagemResponsavel && adminsTriagem[sessaoTriagemResponsavel]
                        ? adminsTriagem[sessaoTriagemResponsavel].apelido : 'Equipe';
                    let msgAprov = `🎉 *SUA TRIAGEM FOI APROVADA!*\n\n✅ Ticket: *#${ticketAprovar}*\n📱 Número: ${entrada.numeroExibir}\n👔 Responsável: *${responsavelApelido}*\n\nParabéns!`;
                    if (linkGrupoTriagem) msgAprov += `\n\n🔗 *Entre no grupo agora:*\n${linkGrupoTriagem}`;
                    await sock.sendMessage(entrada.senderJid, { text: msgAprov });
                    setTimeout(async () => { try { await sock.chatModify({ clear: { before: new Date() } }, entrada.senderJid); } catch {} }, 3 * 60 * 1000);
                } catch {}

                // notifica posição dos que aguardam na fila pendente
                for (let i = 0; i < filaPendente.length; i++) {
                    try { await sock.sendMessage(filaPendente[i].senderJid, { text: `📊 *ATUALIZAÇÃO*\n\nTicket #${filaPendente[i].ticket} — Posição: *${i + 2}º*\n⏳ Aguarde.` }); } catch {}
                }

                // avisa sobre meta
                if (adminsTriagem[sender]) {
                    const total = adminsTriagem[sender].aprovacoes + adminsTriagem[sender].reprovacoes;
                    if (total === metaTriagens) {
                        await sock.sendMessage(jid, { text: `🏆 *META BATIDA!*\n\n👔 ${adminsTriagem[sender].apelido} atingiu *${metaTriagens} triagens* processadas!` });
                    }
                }

                // envia próxima da fila
                await enviarProximaTriagemAoGrupo(sock);
                break;
            }

            case 'reprovar': {
                if (!isSenderAdmin) return;

                if (sessaoTriagemResponsavel && sender !== sessaoTriagemResponsavel &&
                    sender !== DONO_SUPREMO && sender !== DONO_ADMIN) {
                    const respApelido = adminsTriagem[sessaoTriagemResponsavel]?.apelido || 'outro adm';
                    return sock.sendMessage(jid, { text: `❌ Apenas *${respApelido}* pode reprovar agora.` }, { quoted: m });
                }

                const ticketReprovar = parseInt(args[0]);
                if (isNaN(ticketReprovar)) return sock.sendMessage(jid, { text: '❌ Uso: *.reprovar <número>*' }, { quoted: m });
                if (!filaEmAnalise || filaEmAnalise.ticket !== ticketReprovar) {
                    return sock.sendMessage(jid, { text: `❌ Ticket #${ticketReprovar} não está em análise no momento.` }, { quoted: m });
                }

                const entrada = filaEmAnalise;
                entrada.status = 'reprovado';
                filaEmAnalise = null;

                if (adminsTriagem[sender]) adminsTriagem[sender].reprovacoes++;

                await sock.sendMessage(jid, { text: `❌ Ticket #${ticketReprovar} *REPROVADO*.\n📱 ${entrada.numeroExibir}` }, { quoted: m });

                try {
                    const responsavelApelido = sessaoTriagemResponsavel && adminsTriagem[sessaoTriagemResponsavel]
                        ? adminsTriagem[sessaoTriagemResponsavel].apelido : 'Equipe';
                    await sock.sendMessage(entrada.senderJid, {
                        text: `❌ *SUA TRIAGEM FOI REPROVADA*\n\nTicket: *#${ticketReprovar}*\n📱 ${entrada.numeroExibir}\n👔 Responsável: *${responsavelApelido}*\n\nInfelizmente não foi aprovado desta vez.`
                    });
                    setTimeout(async () => { try { await sock.chatModify({ clear: { before: new Date() } }, entrada.senderJid); } catch {} }, 3 * 60 * 1000);
                } catch {}

                for (let i = 0; i < filaPendente.length; i++) {
                    try { await sock.sendMessage(filaPendente[i].senderJid, { text: `📊 *ATUALIZAÇÃO*\n\nTicket #${filaPendente[i].ticket} — Posição: *${i + 2}º*\n⏳ Aguarde.` }); } catch {}
                }

                if (adminsTriagem[sender]) {
                    const total = adminsTriagem[sender].aprovacoes + adminsTriagem[sender].reprovacoes;
                    if (total === metaTriagens) {
                        await sock.sendMessage(jid, { text: `🏆 *META BATIDA!*\n\n👔 ${adminsTriagem[sender].apelido} atingiu *${metaTriagens} triagens* processadas!` });
                    }
                }

                await enviarProximaTriagemAoGrupo(sock);
                break;
            }

            // --------------------------------------------------------
            // METAS
            // --------------------------------------------------------
            case 'metas': {
                if (!isSenderAdmin) return;
                const admLista = Object.entries(adminsTriagem);
                if (!admLista.length) return sock.sendMessage(jid, { text: '❌ Nenhum adm de triagem cadastrado ainda.' }, { quoted: m });

                let painelMetas = `📊 *PAINEL DE METAS — TRIAGENS*\n🎯 Meta atual: *${metaTriagens} triagens*\n━━━━━━━━━━━━━━━━\n\n`;
                for (const [admJid, dados] of admLista) {
                    const total = dados.aprovacoes + dados.reprovacoes;
                    const pct   = metaTriagens > 0 ? Math.min(100, Math.round((total / metaTriagens) * 100)) : 0;
                    const barra = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
                    const plantao = sessaoTriagemResponsavel === admJid ? ' 🟢 *PLANTÃO*' : '';
                    painelMetas += `👔 *${dados.apelido}*${plantao}\n`;
                    painelMetas += `   ✅ Aprovadas: ${dados.aprovacoes} | ❌ Reprovadas: ${dados.reprovacoes}\n`;
                    painelMetas += `   📈 Total: ${total}/${metaTriagens} (${pct}%)\n`;
                    painelMetas += `   [${barra}]\n\n`;
                }
                if (filaEmAnalise) painelMetas += `\n🔍 Em análise: Ticket #${filaEmAnalise.ticket}`;
                painelMetas += `\n📥 Na fila: ${filaPendente.length} triagem(ns)`;
                await sock.sendMessage(jid, { text: painelMetas }, { quoted: m });
                break;
            }

            case 'alterar_meta': {
                if (!isSenderAdmin) return;
                const novaMeta = parseInt(args[0]);
                if (isNaN(novaMeta) || novaMeta < 1) return sock.sendMessage(jid, { text: '❌ Uso: *.alterar_meta <número>*\nExemplo: .alterar_meta 20' }, { quoted: m });
                metaTriagens = novaMeta;
                await sock.sendMessage(jid, { text: `✅ Meta alterada para *${metaTriagens} triagens* por sessão.` }, { quoted: m });
                break;
            }

            // --------------------------------------------------------
            // TIKTOK ALERT
            // --------------------------------------------------------
            case 'alert_tiktok': {
                if (!isSenderAdmin) return;
                const inputTk = args[0];
                if (!inputTk) return sock.sendMessage(jid, { text: '❌ Uso: *.alert_tiktok @nomeusuario*' }, { quoted: m });
                const usernameTk = inputTk.replace(/^@/, '').trim();
                await sock.sendMessage(jid, { text: `⏳ Verificando @${usernameTk}...` }, { quoted: m });
                try {
                    const videoInicial = await buscarUltimoVideoTikTok(usernameTk);
                    alertasTikTok[jid] = { username: usernameTk, ultimoVideoId: videoInicial.id };
                    await sock.sendMessage(jid, { text: `✅ *Alerta TikTok ativado!*\n👤 @${usernameTk}\n📹 Último: ${videoInicial.titulo}\n⏱️ Verifica a cada 5min.\n\nPara remover: *.remover_alert_tiktok*` }, { quoted: m });
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

            // --------------------------------------------------------
            // REGISTRAR / DESATIVAR BOT
            // --------------------------------------------------------
            case 'registrar':
                if (gruposRegistrados.includes(jid)) return sock.sendMessage(jid, { text: '✅ Grupo já registrado!' }, { quoted: m });
                if (!senhaRegistro || args[0] !== senhaRegistro) return sock.sendMessage(jid, { text: `⚠️ Senha inválida.\n🔗 https://servidor-jct9.onrender.com/` }, { quoted: m });
                await sock.sendMessage(jid, { text: '⏳ Registrando...' }, { quoted: m });
                gruposRegistrados.push(jid);
                await syncEstadoBotToGithub();
                senhaRegistro = null;
                await sock.sendMessage(jid, { text: '🚀 *GRUPO REGISTRADO!*' }, { quoted: m });
                break;

            case 'desativa_bot':
                if (!isSenderAdmin) return;
                if (!senhaRegistro || args[0] !== senhaRegistro) return sock.sendMessage(jid, { text: `⚠️ Senha inválida.\n🔗 https://servidor-jct9.onrender.com/` }, { quoted: m });
                await sock.sendMessage(jid, { text: `╭─── [ ⚠️ *BOT DESATIVADO* ] ───╮\n│ O bot sairá em 5 minutos.\n╰─────────────────────╯` });
                gruposRegistrados = gruposRegistrados.filter(id => id !== jid);
                if (grupoTriagemAtivo === jid) grupoTriagemAtivo = null;
                await syncEstadoBotToGithub();
                senhaRegistro = null;
                setTimeout(async () => { try { await sock.sendMessage(jid, { text: '👋 Saindo...' }); await sock.groupLeave(jid); } catch {} }, 300000);
                break;

            // --------------------------------------------------------
            // MODERAÇÃO
            // --------------------------------------------------------
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
                await sock.groupSettingUpdate(jid, 'not_announcement');
                await sock.sendMessage(jid, { text: '✅ Grupo aberto.' });
                break;
            case 'fechar':
                if (!isSenderAdmin) return;
                await sock.groupSettingUpdate(jid, 'announcement');
                await sock.sendMessage(jid, { text: '🔒 Grupo fechado.' });
                break;
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
                } catch { await sock.sendMessage(jid, { text: '❌ Erro ao fixar.' }); }
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

            case 'ranking': {
                if (!isSenderAdmin) return;
                if (!estatisticas[jid] || !Object.keys(estatisticas[jid]).length) return sock.sendMessage(jid, { text: '❌ Sem dados de atividade.' });
                const sorted = Object.entries(estatisticas[jid]).sort(([, a], [, b]) => b.total - a.total).slice(0, 10);
                let rankMsg = `🏆 *RANKING TOP 10*\n\n`;
                sorted.forEach(([u, d], i) => { rankMsg += `${i + 1}º @${u.split('@')[0]} — 💬${d.mensagens} 🖼️${d.fotos} 📹${d.videos} 🗿${d.figurinhas}\n`; });
                await sock.sendMessage(jid, { text: rankMsg, mentions: sorted.map(([u]) => u) });
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
                try { await sock.groupRequestParticipantsUpdate(jid, [userAcc], 'approve'); await sock.sendMessage(jid, { text: `✅ @${userAcc.split('@')[0]} aprovado!`, mentions: [userAcc] }); delete solicitacoesPendentes[jid]; }
                catch { await sock.sendMessage(jid, { text: '❌ Erro ao processar.' }); }
                break;
            }

            case 'recusar': {
                if (!isSenderAdmin) return;
                let userRec = getMention() || solicitacoesPendentes[jid];
                if (!userRec) { try { const reqs = await sock.groupRequestParticipantsList(jid); if (reqs?.length) userRec = reqs[0].jid; } catch {} }
                if (!userRec) return sock.sendMessage(jid, { text: '❌ Sem solicitações pendentes.' });
                await sock.groupRequestParticipantsUpdate(jid, [userRec], 'reject');
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
                    if ((saldosUFSC[sender] || 0) < precoFigurinha) return sock.sendMessage(jid, { text: `❌ Saldo insuficiente.` }, { quoted: m });
                    const quotedA = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const vidA = m.message.videoMessage || quotedA?.videoMessage;
                    if (!vidA) return sock.sendMessage(jid, { text: '❌ Envie ou responda um vídeo com .a' }, { quoted: m });
                    try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
                    if (vidA.seconds > 10) return sock.sendMessage(jid, { text: '❌ Máximo 10 segundos.' }, { quoted: m });
                    const stream = await downloadContentFromMessage(vidA, 'video');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    const sticker = new Sticker(buffer, { pack: 'Atrino Bot', author: 'Garibaldo356', type: StickerTypes.FULL, quality: 50 });
                    await sock.sendMessage(jid, await sticker.toMessage());
                    saldosUFSC[sender] -= precoFigurinha;
                    await sock.sendMessage(jid, { text: `✅ Figurinha animada! 💰 Saldo: ${saldosUFSC[sender]} UFSC` }, { quoted: m });
                } catch { await sock.sendMessage(jid, { text: '❌ Erro.' }); }
                break;
            }

            case 'mat':
            case 'match': {
                try {
                    if ((saldosUFSC[sender] || 0) < precoFigurinha) return sock.sendMessage(jid, { text: `❌ Saldo insuficiente.` }, { quoted: m });
                    const mentM = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    let t1 = body.toLowerCase().includes('@eu') ? sender : mentM[0];
                    let t2 = body.toLowerCase().includes('@eu') ? mentM[0] : mentM[1];
                    if (!t1 || !t2 || t1 === t2) return sock.sendMessage(jid, { text: '❌ Use: .mat @eu @pessoa ou .mat @p1 @p2' }, { quoted: m });
                    const p = Math.floor(Math.random() * 101);
                    const c = p > 75 ? '❤️‍🔥' : p > 50 ? '💖' : p > 25 ? '🧡' : '💔';
                    const f = p > 85 ? 'UM CASAL LENDÁRIO!' : p > 60 ? '💖 Tem futuro!' : p > 40 ? '⚖️ Pode rolar...' : '📉 Melhor na amizade.';
                    saldosUFSC[sender] -= precoFigurinha;
                    await sock.sendMessage(jid, { text: `💘 *ORÁCULO DO AMOR*\n\n@${t1.split('@')[0]} ${c} *${p}%* ${c} @${t2.split('@')[0]}\n\n${f}\n💰 Saldo: ${saldosUFSC[sender]}`, mentions: [t1, t2] }, { quoted: m });
                } catch { await sock.sendMessage(jid, { text: '❌ Erro.' }); }
                break;
            }
        }

        // --------------------------------------------------------
        // CAPTURA ESCOLHA DE HORÁRIO APÓS LOGIN
        // (mensagem numérica de adm que está aguardando escolha)
        // --------------------------------------------------------
        if (adminsTriagem[sender]?._aguardandoEscolha && /^[1-6]$/.test(body.trim())) {
            const dadosAdm = adminsTriagem[sender];
            const idx = parseInt(body.trim()) - 1;
            if (dadosAdm._slotsDisponiveis && dadosAdm._slotsDisponiveis[idx]) {
                dadosAdm.horarioMarcado = dadosAdm._slotsDisponiveis[idx];
                dadosAdm._aguardandoEscolha = false;
                delete dadosAdm._slotsDisponiveis;
                sessaoTriagemResponsavel = sender;
                await sock.sendMessage(jid, {
                    text: `✅ *Plantão marcado!*\n\n👔 *${dadosAdm.apelido}* está de plantão\n🕐 Horário: *${dadosAdm.horarioMarcado}*\n\nApenas você pode aprovar/reprovar as triagens desta sessão.`,
                    mentions: [sender]
                });
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
