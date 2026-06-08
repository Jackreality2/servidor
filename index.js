const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const cron = require('node-cron'); 
const fs = require('fs');
const http = require('http');
const path = require('path');

// --- CORREÇÃO DEFINITIVA DO FFMPEG PARA O RENDER ---
const ffmpegPath = require('ffmpeg-static');
const fluentFfmpeg = require('fluent-ffmpeg');

// Define o caminho do binário estático do ffmpeg-static
fluentFfmpeg.setFfmpegPath(ffmpegPath);

// --- INTEGRAÇÃO DO SOUNDCLOUD ---
const SoundCloud = require("soundcloud-scraper");
const client = new SoundCloud.Client();

const logger = P({ level: 'silent' });

// --- CONFIGURAÇÕES MASTER ---
const DONO_SUPREMO = '5521983161582@s.whatsapp.net'; 
const DONO_ADMIN = '5521935052708@s.whatsapp.net'; 
const ID_DO_GRUPO = '120363425471646460@g.us';
 
let mutados = [];
let advertencias = {}; 
let botSilenciado = false;
let cooldowns = {};
let qrAtual = null; // 🚀 Armazena o QR Code ativo para renderizar na Web do Render
let estatisticas = {};
let contagemAtiva = {};
let saldosUFSC = {};
let anagramaGame = { ativo: false, palavra: "", embaralhada: "", jid: "" };
let notificacoesAtivas = {};

// --- PALAVRAS PARA ANAGRAMA (Simulando IA) ---
const listaPalavras = ["computador", "whatsapp", "javascript", "teclado", "celular", "inteligencia", "programador", "saturno", "banana", "guitarra", "futebol", "universo"];

function gerarAnagrama() {
    const palavra = listaPalavras[Math.floor(Math.random() * listaPalavras.length)];
    let arr = palavra.split('');
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return { original: palavra, embaralhada: arr.join('').toUpperCase() };
}

// --- PORTA DINÂMICA EXIGIDA PELO RENDER ---
const PORT = parseInt(process.env.PORT, 10) || 7860;

// --- SERVIDOR WEB DE MONITORAMENTO E QR CODE ---
http.createServer((req, res) => {
    // Caso o bot já esteja conectado e ativo
    if (!qrAtual) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <html>
                <head>
                    <title>Atrino Bot - Status</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; margin-top: 80px; background-color: #0f0c1b; color: #00ffcc; }
                        .card { background: #17142b; display: inline-block; padding: 30px; border-radius: 15px; border: 1px solid #3d3475; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>🚀 Atrino Bot: Conectado e Ativo!</h1>
                        <p style="color: #b3b0cb;">O monitoramento e o keep-alive no Render estão rodando perfeitamente.</p>
                    </div>
                </body>
            </html>
        `);
        return;
    }

    // Caso o bot precise de escaneamento (Gera página com auto-refresh de 5 segundos)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <html>
            <head>
                <title>Atrino Bot - Conexão</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; background-color: #111; color: #fff; }
                    .qr-container { margin-top: 30px; }
                </style>
            </head>
            <body>
                <h1 style="color: #25D366;">Escaneie o QR Code do Atrino Bot</h1>
                <p>Esta página atualiza sozinha a cada 5 segundos para manter o código sincronizado!</p>
                <div class="qr-container">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrAtual)}" style="border: 10px solid white; border-radius: 10px; box-shadow: 0px 0px 20px rgba(255,255,255,0.2);" />
                </div>
                <p style="margin-top: 20px; color: #aaa; font-size: 14px;">Abra o WhatsApp > Aparelhos Conectados > Conectar um aparelho</p>
            </body>
        </html>
    `);
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🛰️ Servidor Keep-Alive e Web-QR ativo na porta ${PORT}`);
    // Auto-ping interno para evitar que o Render derrube o processo por inatividade
    setInterval(() => {
        http.get(`http://localhost:${PORT}`).on('error', () => {});
    }, 60000); // 1 minuto
});

async function startAtrinoBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    if (state.creds && state.creds.signedRegistrationInfo) {
        console.log('📦 Carregando sessão existente da pasta "auth_info"...');
    }

    // --- CONFIGURAÇÃO CONTRA BLOQUEIOS ---
    const sock = makeWASocket({
        logger,
        auth: state,
        printQRInTerminal: false,
        browser: ['Mac OS', 'Chrome', '121.0.0.0'], 
        connectTimeoutMs: 120000, 
        keepAliveIntervalMs: 30000,
        markOnline: true,
        shouldSyncHistoryMessage: () => false,
        receivedPendingNotifications: false, 
    });

    sock.ev.on('creds.update', saveCreds);

    // --- SISTEMA DE BOAS-VINDAS ---
    sock.ev.on('group-participants.update', async (anu) => {
        // Notificação de Solicitação de Entrada ou Novos Membros
        if (!notificacoesAtivas[anu.id]) return;

        if (anu.action === 'add') {
            for (const participant of anu.participants) {
                let ppUrl;
                try {
                    ppUrl = await sock.profilePictureUrl(participant, 'image');
                } catch {
                    ppUrl = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
                }
                const welcomeText = `╭─── [ ✨ *NOVO MEMBRO* ] ───╮\n│\n│  🌟 *Seja muito bem-vindo(a)!*\n│\n│  👤 @${participant.split('@')[0]}\n│  🏠 *Salão:* Atrino Bot\n│\n│  ➥ Leia as regras para evitar punições.\n│  ➥ Sinta-se em casa no nosso salão!\n╰─────────────────────╯`;
                await sock.sendMessage(anu.id, { image: { url: ppUrl }, caption: welcomeText, mentions: [participant] });
            }
        } else if (anu.action === 'request') {
            const solicitante = anu.participants[0];
            const msgReq = `🔔 *SOLICITAÇÃO DE ENTRADA*\n\n` +
                           `👤 Contato: @${solicitante.split('@')[0]}\n` +
                           `🔢 Número: ${solicitante.split('@')[0]}\n\n` +
                           `Use *.aceitar @user* ou *.recusar @user* para gerenciar.`;
            await sock.sendMessage(anu.id, { text: msgReq, mentions: [solicitante] });
        }
    });

    // --- AGENDAMENTOS AUTOMÁTICOS ---
    cron.schedule('0 0 * * *', async () => {
        try {
            await sock.groupSettingUpdate(ID_DO_GRUPO, 'announcement');
            const textoFechado = `╭─── [ 🔒 *SALÃO ENCERRADO* ] ───╮\n│\n│ 🌑 *O silêncio retorna ao salão.*\n│ ➥ As vozes agora repousam sob o lunar.\n│ ➥ Horário de descanso: 00:00h\n│\n╰─────────────────────╯`;
            await sock.sendMessage(ID_DO_GRUPO, { text: textoFechado });
        } catch (err) {}
    }, { timezone: "America/Sao_Paulo" });

    cron.schedule('0 4 * * *', async () => {
        try {
            await sock.groupSettingUpdate(ID_DO_GRUPO, 'not_announcement');
            const textoAberto = `╭─── [ 🔓 *SALÃO ABERTO* ] ───╮\n│\n│ 🌅 *As portas do salão se abrem.*\n│ ➥ O diálogo renasce sob o tempo marcado.\n│ ➥ Horário de despertar: 04:00h\n│\n╰─────────────────────╯`;
            await sock.sendMessage(ID_DO_GRUPO, { text: textoAberto });
        } catch (err) {}
    }, { timezone: "America/Sao_Paulo" });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrAtual = qr; 
            const qrLink = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr);
            console.log('\n🔗 LINK DO QR CODE NO RENDER: ' + qrLink + '\n');
            qrcode.generate(qr, { small: false });
        }
        if (connection === 'open') {
            qrAtual = null; 
            console.log('\n✅ ATRINO BOT ONLINE NO RENDER!\n');
        }
        if (connection === 'close') {
            qrAtual = null;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`🔌 Conexão encerrada. Razão: ${reason}`);
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) { 
                console.log('🔄 Tentando reconectar automaticamente...'); 
                startAtrinoBot(); 
            } else {
                console.log('❌ Sessão encerrada permanentemente. É necessário ler o QR Code de novo.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return; 
        const sender = m.key.participant || m.key.remoteJid;

        // --- SISTEMA DE CONTAGEM DE ATIVIDADE ---
        if (contagemAtiva[jid]) {
            if (!estatisticas[jid]) estatisticas[jid] = {};
            if (!estatisticas[jid][sender]) {
                estatisticas[jid][sender] = { mensagens: 0, fotos: 0, videos: 0, figurinhas: 0, total: 0 };
            }
            const userActivity = estatisticas[jid][sender];
            userActivity.total++;
            if (m.message.conversation || m.message.extendedTextMessage) userActivity.mensagens++;
            else if (m.message.imageMessage) userActivity.fotos++;
            else if (m.message.videoMessage) userActivity.videos++;
            else if (m.message.stickerMessage) userActivity.figurinhas++;
        }
        
        const body = (m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || "");

        // --- VERIFICAÇÃO DE RESPOSTA DO ANAGRAMA ---
        if (anagramaGame.ativo && anagramaGame.jid === jid && body.toLowerCase() === anagramaGame.palavra) {
            if (!saldosUFSC[sender]) saldosUFSC[sender] = 0;
            saldosUFSC[sender] += 1;
            await sock.sendMessage(jid, { text: `🎉 *ACERTOU!* @${sender.split('@')[0]} ganhou 1 moeda UFSC! 🪙\n💰 Saldo atual: ${saldosUFSC[sender]} UFSC.\n\nPróxima palavra vindo...`, mentions: [sender] });
            const novo = gerarAnagrama();
            anagramaGame.palavra = novo.original;
            anagramaGame.embaralhada = novo.embaralhada;
            return await sock.sendMessage(jid, { text: `🧩 Forme a palavra: *${anagramaGame.embaralhada}*` });
        }

        if (mutados.includes(sender)) {
            try {
                return await sock.sendMessage(jid, { delete: m.key });
            } catch {
                return;
            }
        }

        let isSenderAdmin = (sender === DONO_SUPREMO || sender === DONO_ADMIN);
        if (jid.endsWith('@g.us') && !isSenderAdmin) {
            try {
                const metadata = await sock.groupMetadata(jid);
                isSenderAdmin = metadata.participants.filter(p => p.admin !== null).map(p => p.id).includes(sender);
            } catch (e) {}
        }

        if (body.includes('@name') && isSenderAdmin) {
            const metadata = await sock.groupMetadata(jid);
            const participants = metadata.participants.map(p => p.id);
            await sock.sendMessage(jid, { text: `📢 *Chamada Geral no Salão!*`, mentions: participants });
        }

        if (!body.startsWith('.')) return;

        const args = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // --- SISTEMA DE COOLDOWN (10 SEGUNDOS) ---
        const agora = Date.now();
        const tempoEspera = 10000; // 10 segundos em milissegundos
        if (cooldowns[sender] && agora < cooldowns[sender] + tempoEspera) {
            const restante = ((cooldowns[sender] + tempoEspera - agora) / 1000).toFixed(1);
            return await sock.sendMessage(jid, { text: `⏳ *Calma lá!* Aguarde ${restante}s para usar outro comando.` }, { quoted: m });
        }
        cooldowns[sender] = agora;

        let mentions = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const getMention = () => mentions[0] || m.message.extendedTextMessage?.contextInfo?.participant;

        if (sender === DONO_SUPREMO && command === 'off') { botSilenciado = true; return sock.sendMessage(jid, { text: '🔇 Bot OFF.' }); }
        if (sender === DONO_SUPREMO && command === 'on') { botSilenciado = false; return sock.sendMessage(jid, { text: '🔊 Bot ON.' }); }
        if (botSilenciado) return;

        switch (command) {
            case 'menu':
                if (!isSenderAdmin) {
                    return await sock.sendMessage(jid, { text: '❌ Apenas administradores podem ver o menu!' }, { quoted: m });
                }

                const menu = `╭─── [ ATRINO BOT ] ───╮
│
│ 🧑‍🤝‍🧑 *Membros:*
│ ➥ .s - Figurinha (Foto)
│ ➥ .a - Figurinha Animada (Vídeo)
│
│ 👮 *Admin:*
│ ➥ .play [nome] - Tocar música
│ ➥ .contador - Ativar/Desativar contagem
│ ➥ .id - Ver ID do grupo
│ ➥ .ranking - Lista de mais ativos
│ ➥ .ativar_anagrama - Inicia jogo
│ ➥ .desativa_anagrama - Para jogo
│ ➥ .notificar - Avisos de entrada
│ ➥ .naonotificar - Silenciar avisos
│ ➥ .tornaadm @user - Dar Admin
│ ➥ .totag - Marcar o grupo
│ ➥ .adv @user - Dar advertência
│ ➥ .unadv @user - Remover adv
│ ➥ .mute @user - Silenciar
│ ➥ .desmute @user - Liberar
│ ➥ .fixar - Fixar mensagem
│ ➥ .ban @user - Banir
│ ➥ .abrir - Abrir grupo
│ ➥ .fechar - Fechar grupo
│ ➥ @name - Mencionar todos
│
╰───────────────────╯`;
                await sock.sendMessage(jid, { text: menu }, { quoted: m });
                break;

            case 'play':
            case 'yt':
            case 'youtube':
                try {
                    if (!isSenderAdmin) {
                        return await sock.sendMessage(jid, { text: '❌ Apenas administradores podem usar o comando de música!' }, { quoted: m });
                    }

                    const busca = args.join(' ');
                    if (!busca) return await sock.sendMessage(jid, { text: '❌ Digite o nome da música ou o link! Exemplo: .play Nome da Musica' }, { quoted: m });

                    await sock.sendMessage(jid, { text: `🎵 Buscando "${busca}"...` }, { quoted: m });

                    // Busca a música no SoundCloud (já configurado no seu código)
                    const pesquisa = await client.search(busca, 'track');
                    if (!pesquisa || pesquisa.length === 0) {
                        return await sock.sendMessage(jid, { text: '❌ Nenhuma música encontrada com esse nome.' }, { quoted: m });
                    }

                    const info = await client.getSongInfo(pesquisa[0].url);
                    const stream = await info.downloadProgressive();

                    const arquivoTemporarioOgg = path.join('/tmp', `api_${Date.now()}.ogg`);

                    await sock.sendMessage(jid, { text: `🎧 Processando: *${info.title}*` });

                    // Converte o stream do SoundCloud diretamente para OGG/Opus (formato nativo do WhatsApp)
                    await new Promise((resolve, reject) => {
                        fluentFfmpeg(stream)
                            .audioCodec('libopus')
                            .toFormat('ogg')
                            .on('end', resolve)
                            .on('error', reject)
                            .save(arquivoTemporarioOgg);
                    });

                    if (!fs.existsSync(arquivoTemporarioOgg) || fs.statSync(arquivoTemporarioOgg).size === 0) {
                        throw new Error("O arquivo convertido está vazio.");
                    }

                    const audioBuffer = fs.readFileSync(arquivoTemporarioOgg);

                    // Envia como nota de voz no WhatsApp
                    await sock.sendMessage(jid, { 
                        audio: audioBuffer, 
                        mimetype: 'audio/ogg; codecs=opus', 
                        ptt: true 
                    }, { quoted: m });

                    // Limpeza
                    if (fs.existsSync(arquivoTemporarioOgg)) fs.unlinkSync(arquivoTemporarioOgg);

                } catch (playErr) {
                    console.error('Erro geral no comando play via API:', playErr);
                    await sock.sendMessage(jid, { text: '❌ Erro ao processar a música. Tente outro nome ou link.' }, { quoted: m });
                }
                break;     
            case 's':
            case 'sticker':
                try {
                    const quotedS = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const imgS = m.message.imageMessage || quotedS?.imageMessage;
                    if (imgS) {
                        const stream = await downloadContentFromMessage(imgS, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        
                        const sticker = new Sticker(buffer, { pack: 'Atrino Bot', author: 'Garibaldo356', type: StickerTypes.FULL });
                        await sock.sendMessage(jid, await sticker.toMessage());
                        
                        try {
                            await sock.sendMessage(jid, { delete: m.key });
                        } catch (delErr) {
                            console.log('Erro ao deletar imagem (Verifique se o bot é Admin):', delErr.message);
                        }
                    }
                } catch (stkErr) {
                    console.error('Erro no comando de sticker:', stkErr);
                }
                break;

            case 'a':
            case 'animada':
                try {
                    const quotedA = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const vidA = m.message.videoMessage || quotedA?.videoMessage;
                    
                    if (vidA) {
                        if (vidA.seconds > 10) return sock.sendMessage(jid, { text: '❌ O vídeo deve ter no máximo 10 segundos para virar figurinha!' }, { quoted: m });

                        const stream = await downloadContentFromMessage(vidA, 'video');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        
                        const sticker = new Sticker(buffer, { 
                            pack: 'Atrino Bot', 
                            author: 'Garibaldo356', 
                            type: StickerTypes.FULL,
                            quality: 50 
                        });

                        await sock.sendMessage(jid, await sticker.toMessage());
                        try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
                    } else {
                        await sock.sendMessage(jid, { text: '❌ Responda a um vídeo ou envie um com o comando .a para fazer uma figurinha animada!' }, { quoted: m });
                    }
                } catch (err) {
                    console.error('Erro no comando .a:', err);
                    await sock.sendMessage(jid, { text: '❌ Erro ao converter vídeo para figurinha.' });
                }
                break;

            case 'tornaadm':
                if (!isSenderAdmin) return;
                const userToAdmin = getMention();
                if (!userToAdmin) return sock.sendMessage(jid, { text: '❌ Mencione alguém!' });
                await sock.groupParticipantsUpdate(jid, [userToAdmin], "promote");
                await sock.sendMessage(jid, { text: `✅ @${userToAdmin.split('@')[0]} agora é Admin!`, mentions: [userToAdmin] });
                break;

            case 'mute':
                if (!isSenderAdmin || !getMention()) return;
                if (!mutados.includes(getMention())) mutados.push(getMention());
                await sock.sendMessage(jid, { text: '🤫 Silenciado.', mentions: [getMention()] });
                break;

            case 'desmute':
                if (!isSenderAdmin || !getMention()) return;
                mutados = mutados.filter(x => x !== getMention());
                await sock.sendMessage(jid, { text: '🔊 Liberado.', mentions: [getMention()] });
                break;

            case 'adv':
                if (!isSenderAdmin || !getMention()) return;
                const uAdv = getMention();
                advertencias[uAdv] = (advertencias[uAdv] || 0) + 1;
                if (advertencias[uAdv] >= 3) {
                    await sock.sendMessage(jid, { text: `🚫 @${uAdv.split('@')[0]} atingiu 3/3 e foi removido.`, mentions: [uAdv] });
                    await sock.groupParticipantsUpdate(jid, [uAdv], "remove");
                    delete advertencias[uAdv];
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ Adv ${advertencias[uAdv]}/3 para @${uAdv.split('@')[0]}`, mentions: [uAdv] });
                }
                break;

            case 'unadv':
                if (!isSenderAdmin || !getMention()) return;
                if (advertencias[getMention()]) {
                    advertencias[getMention()]--;
                    await sock.sendMessage(jid, { text: `✅ Advertência removida.`, mentions: [getMention()] });
                }
                break;

            case 'totag':
                if (!isSenderAdmin) return;
                const metadata = await sock.groupMetadata(jid);
                let textT = `📢 *AVISO GERAL*\n\n${args.join(' ') || 'Atenção!'}\n\n`;
                let mnts = metadata.participants.map(p => p.id);
                for (let mem of metadata.participants) textT += `➥ @${mem.id.split('@')[0]}\n`;
                await sock.sendMessage(jid, { text: textT, mentions: mnts });
                break;

            case 'abrir':
                if (!isSenderAdmin) return;
                await sock.groupSettingUpdate(jid, 'not_announcement');
                const aberto = `╭─── [ 🔓 *SALÃO ABERTO* ] ───╮\n│\n│ 🌅 *As portas do salão se abrem.*\n│ ➥ O diálogo renasce sob o tempo marcado.\n│ ➥ Horário de despertar: 04:00h\n│\n╰─────────────────────╯`;
                await sock.sendMessage(jid, { text: aberto });
                break;

            case 'fechar':
                if (!isSenderAdmin) return;
                await sock.groupSettingUpdate(jid, 'announcement');
                const fechado = `╭─── [ 🔒 *SALÃO ENCERRADO* ] ───╮\n│\n│ 🌑 *O silêncio retorna ao salão.*\n│ ➥ As vozes agora repousam sob o lunar.\n│ ➥ Horário de descanso: 00:00h\n│\n╰─────────────────────╯`;
                await sock.sendMessage(jid, { text: fechado });
                break;

            case 'ban':
                if (isSenderAdmin && getMention()) await sock.groupParticipantsUpdate(jid, [getMention()], "remove");
                break;

            case 'fixar':
                if (!isSenderAdmin) return;
                const quotedFix = m.message.extendedTextMessage?.contextInfo;
                if (!quotedFix || !quotedFix.stanzaId) {
                    return sock.sendMessage(jid, { text: '❌ Responda à mensagem que deseja fixar!' });
                }

                const botJid = jidNormalizedUser(sock.user.id);
                const participant = quotedFix.participant || quotedFix.remoteJid;

                const keyToPin = {
                    remoteJid: jid,
                    fromMe: participant === botJid,
                    id: quotedFix.stanzaId,
                    participant: participant
                };

                try {
                    await sock.relayMessage(jid, {
                        pinInChat: {
                            key: keyToPin,
                            type: 1, 
                            time: 2592000 
                        }
                    }, {});
                } catch (err) {
                    console.error('Erro ao fixar mensagem:', err);
                    await sock.sendMessage(jid, { text: '❌ Erro ao fixar. Verifique se sou administrador do grupo.' });
                }
                break;

            case 'id':
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Comando restrito a administradores!' }, { quoted: m });
                await sock.sendMessage(jid, { text: `🆔 *ID deste grupo:* ${jid}` }, { quoted: m });
                break;

            case 'contador':
            case 'contado':
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Comando restrito a administradores!' }, { quoted: m });
                
                contagemAtiva[jid] = !contagemAtiva[jid];
                const statusTxt = contagemAtiva[jid] ? '✅ *ATIVADA*' : '❌ *DESATIVADA*';
                
                await sock.sendMessage(jid, { text: `📊 A contagem de estatísticas foi ${statusTxt} neste grupo.\n\nUse *.ranking* para ver os resultados.` }, { quoted: m });
                break;

            case 'ranking':
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Comando restrito a administradores!' }, { quoted: m });
                if (!estatisticas[jid] || Object.keys(estatisticas[jid]).length === 0) return sock.sendMessage(jid, { text: '❌ Ainda não há dados de atividade para gerar o ranking.' });

                const sortedActivity = Object.entries(estatisticas[jid])
                    .sort(([, a], [, b]) => b.total - a.total)
                    .slice(0, 10);

                let rankMsg = `🏆 *RANKING DE ATIVIDADE - TOP 10* 🏆\n\n`;
                sortedActivity.forEach(([user, data], index) => {
                    rankMsg += `${index + 1}º - @${user.split('@')[0]}\n`;
                    rankMsg += `   💬 Msg: ${data.mensagens} | 🖼️: ${data.fotos} | 📹: ${data.videos} | 🗿: ${data.figurinhas}\n\n`;
                });

                await sock.sendMessage(jid, { text: rankMsg, mentions: sortedActivity.map(([u]) => u) });
                break;

            case 'ativar_anagrama':
                if (!isSenderAdmin) return sock.sendMessage(jid, { text: '❌ Apenas ADMs podem ativar o jogo.' });
                if (anagramaGame.ativo) return sock.sendMessage(jid, { text: '🕹️ O jogo já está rolando!' });
                
                const jogo = gerarAnagrama();
                anagramaGame = { ativo: true, palavra: jogo.original, embaralhada: jogo.embaralhada, jid: jid };
                await sock.sendMessage(jid, { text: `🎮 *ANAGRAMA ATIVADO!*\n\nForme a palavra correta para ganhar moedas *UFSC*.\n\n🧩 Desafio: *${anagramaGame.embaralhada}*` });
                break;

            case 'desativa_anagrama':
                if (!isSenderAdmin) return;
                anagramaGame.ativo = false;
                await sock.sendMessage(jid, { text: '🛑 O jogo de anagrama foi encerrado.' });
                break;

            case 'notificar':
                if (!isSenderAdmin) return;
                notificacoesAtivas[jid] = true;
                await sock.sendMessage(jid, { text: '🔔 Notificações de entrada/solicitação: *ATIVADAS*' });
                break;

            case 'naonotificar':
                if (!isSenderAdmin) return;
                notificacoesAtivas[jid] = false;
                await sock.sendMessage(jid, { text: '🔕 Notificações de entrada/solicitação: *DESATIVADAS*' });
                break;

            case 'aceitar':
                if (!isSenderAdmin) return;
                const userAcc = getMention();
                if (!userAcc) return sock.sendMessage(jid, { text: '❌ Mencione o usuário que deseja aceitar!' });
                try {
                    await sock.groupRequestParticipantsUpdate(jid, [userAcc], "approve");
                    await sock.sendMessage(jid, { text: `✅ @${userAcc.split('@')[0]} foi aceito no grupo!`, mentions: [userAcc] });
                } catch (err) {
                    await sock.sendMessage(jid, { text: '❌ Erro ao aceitar. A solicitação pode ter expirado ou o bot não é admin.' });
                }
                break;

            case 'recusar':
                if (!isSenderAdmin) return;
                const userRec = getMention();
                if (!userRec) return sock.sendMessage(jid, { text: '❌ Mencione o usuário que deseja recusar!' });
                await sock.groupRequestParticipantsUpdate(jid, [userRec], "reject");
                await sock.sendMessage(jid, { text: `🚫 Solicitação de @${userRec.split('@')[0]} recusada.`, mentions: [userRec] });
                break;
        }
    });
}

startAtrinoBot();
