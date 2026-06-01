const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const cron = require('node-cron'); 
const fs = require('fs');
const { exec } = require('child_process');
const http = require('http');
const axios = require('axios'); 
const Jimp = require('jimp'); 

const logger = P({ level: 'silent' });

// --- CONFIGURAÇÕES MASTER ---
const DONO_SUPREMO = '5521983161582@s.whatsapp.net'; 
const DONO_ADMIN = '5521935052708@s.whatsapp.net'; 
const ID_DO_GRUPO = '120363425471646460@g.us';
 
let mutados = [];
let advertencias = {}; 
let estaBaixando = false; 
let botSilenciado = false;
let perfis = fs.existsSync('./perfis.json') ? JSON.parse(fs.readFileSync('./perfis.json')) : {};
let pontosFilmes = fs.existsSync('./pontos_filmes.json') ? JSON.parse(fs.readFileSync('./pontos_filmes.json')) : {};
let jogosAtivos = {};

const filmes = [
    { nome: 'O Rei Leão', emojis: '🦁👑🌅' },
    { nome: 'Titanic', emojis: '🚢🧊🌊' },
    { nome: 'Homem Aranha', emojis: '🕷️🕸️🏙️' },
    { nome: 'It a Coisa', emojis: '🤡🎈🎈' },
    { nome: 'Harry Potter', emojis: '🧙‍♂️⚡👓' },
    { nome: 'Jurassic Park', emojis: '🦖🌴🦕' },
    { nome: 'Batman', emojis: '🦇🌃🌑' },
    { nome: 'Star Wars', emojis: '🪐⚔️🚀' },
    { nome: 'Procurando Nemo', emojis: '🐟🌊🤿' },
    { nome: 'Toy Story', emojis: '🧸🤠🚀' }
];

// --- SISTEMA ANTI-HIBERNAÇÃO (KEEP-ALIVE) ---
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Atrino Bot: Monitoramento Ativo.\n');
}).listen(7860, '0.0.0.0', () => {
    console.log('🛰️ Servidor Keep-Alive rodando na porta 7860');
    // Auto-ping interno para evitar hibernação do processo por inatividade
    setInterval(() => {
        http.get('http://localhost:7860').on('error', () => {});
    }, 120000); // 2 minutos
});

async function startAtrinoBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    // Verifica se já existem credenciais salvas para informar no log
    if (state.creds && state.creds.signedRegistrationInfo) {
        console.log('📦 Carregando sessão existente da pasta "auth_info"...');
    }

    const { version } = await fetchLatestBaileysVersion();

    // --- CONFIGURAÇÃO CORRIGIDA PARA EVITAR REJEIÇÃO DO WHATSAPP WEB ---
    const sock = makeWASocket({
        version: version || [2, 3000, 1017531287], // Força última versão estável se falhar
        logger,
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // Simula um navegador comum para evitar bloqueios de login
        connectTimeoutMs: 120000, // Aumentado para 2 minutos para evitar timeout em conexões lentas
        keepAliveIntervalMs: 30000,
        markOnline: true,
        shouldSyncHistoryMessage: () => false,
        receivedPendingNotifications: true, 
    });

    sock.ev.on('creds.update', saveCreds);

    const iniciarRodada = async (sock, jid) => {
        const filme = filmes[Math.floor(Math.random() * filmes.length)];
        if (jogosAtivos[jid]?.intervalo) clearInterval(jogosAtivos[jid].intervalo);
        
        jogosAtivos[jid] = { 
            filme, 
            intervalo: setInterval(async () => {
                await sock.sendMessage(jid, { text: `🎬 *QUAL É O FILME?*\n\nEmojis: ${filme.emojis}\n\nResponda com o nome correto!` });
            }, 60000) 
        };
        await sock.sendMessage(jid, { text: `🎬 *QUAL É O FILME?*\n\nEmojis: ${filme.emojis}\n\nBoa sorte!` });
    };

    // --- SISTEMA DE BOAS-VINDAS ---
    sock.ev.on('group-participants.update', async (anu) => {
        if (anu.action === 'add' && anu.id === ID_DO_GRUPO) {
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
            const qrLink = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr);
            console.log('\n🔗 LINK DO QR CODE: ' + qrLink + '\n');
            qrcode.generate(qr, { small: false });
        }
        if (connection === 'open') {
            console.log('\n✅ ATRINO BOT ONLINE!\n');
        }
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`🔌 Conexão encerrada. Razão: ${reason}`);
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) { 
                console.log('🔄 Tentando reconectar automaticamente...'); 
                startAtrinoBot(); 
            } else {
                console.log('❌ Sessão encerrada permanentemente. Você precisará escanear o QR Code novamente.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const jid = m.key.remoteJid;
        if (!jid.endsWith('@g.us')) return; // Bloqueia respostas em privados
        const sender = m.key.participant || m.key.remoteJid;
        
        if (mutados.includes(sender)) return await sock.sendMessage(jid, { delete: m.key });

        const body = (m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || "");
        
        // --- LÓGICA DO JOGO DE FILMES (CHECA ACERTO) ---
        if (jogosAtivos[jid] && body) {
            const jogo = jogosAtivos[jid];
            if (body.toLowerCase().trim() === jogo.filme.nome.toLowerCase().trim()) {
                pontosFilmes[sender] = (pontosFilmes[sender] || 0) + 1;
                fs.writeFileSync('./pontos_filmes.json', JSON.stringify(pontosFilmes, null, 2));
                clearInterval(jogo.intervalo);
                await sock.sendMessage(jid, { text: `🎉 *ACERTOU!* @${sender.split('@')[0]} ganhou 1 ponto.\n🎬 Filme: *${jogo.filme.nome}*\n\nPróxima rodada em instantes...`, mentions: [sender] });
                setTimeout(() => { if (jogosAtivos[jid]) iniciarRodada(sock, jid); }, 3000);
                return;
            }
        }

        // --- SISTEMA DE EDIÇÃO DE PERFIL ---
        if (body.toLowerCase().includes('!editapronto')) {
            const idade = body.match(/Idade:\s*([^\n\r]*)/i)?.[1]?.trim();
            const sexualidade = body.match(/Sexualidade:\s*([^\n\r]*)/i)?.[1]?.trim();
            const estadoCivil = body.match(/Estado\s*Civil:\s*([^\n\r]*)/i)?.[1]?.trim();
            const hobbies = body.match(/Hobbies:\s*([^\n\r]*)/i)?.[1]?.trim();

            if (idade || sexualidade || estadoCivil || hobbies) {
                perfis[sender] = {
                    idade: idade || 'Não informado',
                    sexualidade: sexualidade || 'Não informado',
                    estadoCivil: estadoCivil || 'Não informado',
                    hobbies: hobbies || 'Não informado'
                };
                fs.writeFileSync('./perfis.json', JSON.stringify(perfis, null, 2));
                return await sock.sendMessage(jid, { text: '✅ *Perfil updated com sucesso!* Digite !perfil para ver seu cartão.' });
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

        if (!body.startsWith('!')) return;

        const args = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        let mentions = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const getMention = () => mentions[0] || m.message.extendedTextMessage?.contextInfo?.participant;

        if (sender === DONO_SUPREMO && command === 'off') { botSilenciado = true; return sock.sendMessage(jid, { text: '🔇 Bot OFF.' }); }
        if (sender === DONO_SUPREMO && command === 'on') { botSilenciado = false; return sock.sendMessage(jid, { text: '🔊 Bot ON.' }); }
        if (botSilenciado) return;

        switch (command) {
            case 'menu':
                const menu = `╭─── [ ATRINO BOT ] ───╮
│
│ 🧑‍🤝‍🧑 *Público:*
│ ➥ !mat @user1 @user2 - Cupido
│ ➥ !s - Figurinha (Foto)
│ ➥ !a - Figurinha (Vídeo)
│ ➥ !play - Música (SoundCloud)
│ ➥ !editar - Criar/Editar Perfil
│ ➥ !perfil - Ver seu perfil ou de alguém
│ ➥ !iniciar - Iniciar Jogo
│ ➥ !stop - Parar Jogo
│ ➥ !pontos - Ver seus pontos
│
│ 👮 *Admin:*
│ ➥ !tornaadm @user - Dar Admin
│ ➥ !totag - Marcar o grupo
│ ➥ !adv @user - Dar advertência
│ ➥ !unadv @user - Remover adv
│ ➥ !mute @user - Silenciar
│ ➥ !desmute @user - Liberar
│ ➥ !fixar - Fixar mensagem
│ ➥ !ban @user - Banir
│ ➥ !abrir - Abrir grupo
│ ➥ !fechar - Fechar grupo
│ ➥ @name - Mencionar todos
│
╰───────────────────╯`;
                await sock.sendMessage(jid, { text: menu }, { quoted: m });
                break;

            case 'play':
                if (!args.length || estaBaixando) return;
                estaBaixando = true;
                const query = args.join(' ');
                await sock.sendMessage(jid, { text: `🎧 Buscando no SoundCloud: *${query}*...` });
                const filePath = `./${Date.now()}.mp3`;
                const cmd = `yt-dlp --no-check-certificates --max-filesize 50M "scsearch1:${query}" -x --audio-format mp3 -o "${filePath}"`;
                exec(cmd, async (err) => {
                    if (!err && fs.existsSync(filePath)) {
                        await sock.sendMessage(jid, { audio: { url: filePath }, mimetype: 'audio/mp4' }, { quoted: m });
                        fs.unlinkSync(filePath);
                    } else { sock.sendMessage(jid, { text: '❌ Erro ao baixar música do SoundCloud.' }); }
                    estaBaixando = false;
                });
                break;

            case 'tornaadm':
                if (!isSenderAdmin) return;
                const userToAdmin = getMention();
                if (!userToAdmin) return sock.sendMessage(jid, { text: '❌ Mencione alguém!' });
                await sock.groupParticipantsUpdate(jid, [userToAdmin], "promote");
                await sock.sendMessage(jid, { text: `✅ @${userToAdmin.split('@')[0]} agora é Admin!`, mentions: [userToAdmin] });
                break;

            case 'mat':
                if (body.toLowerCase().includes('@eu') && !mentions.includes(sender)) {
                    mentions.push(sender);
                }

                if (mentions.length !== 2) return sock.sendMessage(jid, { text: '❌ Mencione 2 pessoas (ou use @eu e mencione outra): !mat @eu @pessoa' });
                
                try {
                    await sock.sendMessage(jid, { text: '❤️ *Montando o clima amoroso...*' });
                    let p1, p2;
                    try { p1 = await sock.profilePictureUrl(mentions[0], 'image'); } catch { p1 = 'https://i.imgur.com/83p1qS6.png'; }
                    try { p2 = await sock.profilePictureUrl(mentions[1], 'image'); } catch { p2 = 'https://i.imgur.com/83p1qS6.png'; }
                    const img1 = await Jimp.read(p1);
                    const img2 = await Jimp.read(p2);
                    const heart = await Jimp.read('https://i.imgur.com/Ewx3c4P.png');
                    img1.resize(300, 300); img2.resize(300, 300); heart.resize(150, 150);
                    const canvas = new Jimp(750, 350, 0x00000000);
                    canvas.composite(img1, 50, 25); canvas.composite(img2, 400, 25); canvas.composite(heart, 300, 100);
                    const outPath = `./match_${Date.now()}.png`;
                    await canvas.writeAsync(outPath);
                    const chance = Math.floor(Math.random() * 101);
                    const msg = `╭─── [ ❤️ *ATURINO MATCH* ] ───╮\n│\n│ ✨ @${mentions[0].split('@')[0]} & @${mentions[1].split('@')[0]}\n│ ❤️ *Chance:* ${chance}%\n╰──────────────────────╯`;
                    await sock.sendMessage(jid, { image: { url: outPath }, caption: msg, mentions: mentions });
                    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
                } catch (e) { sock.sendMessage(jid, { text: '❌ Erro ao gerar Match.' }); }
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

            case 's':
            case 'sticker':
                const quotedS = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                const imgS = m.message.imageMessage || quotedS?.imageMessage;
                if (imgS) {
                    const stream = await downloadContentFromMessage(imgS, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    const sticker = new Sticker(buffer, { pack: 'Atrino Bot', author: 'Garibaldo356', type: StickerTypes.FULL });
                    await sock.sendMessage(jid, await sticker.toMessage());
                    await sock.sendMessage(jid, { delete: m.key });
                }
                break;

            case 'a':
                const quotedA = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                const vidA = m.message.videoMessage || quotedA?.videoMessage;
                if (vidA && vidA.seconds <= 10) {
                    const stream = await downloadContentFromMessage(vidA, 'video');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                    const sticker = new Sticker(buffer, { pack: 'Animado', author: 'Garibaldo356', type: StickerTypes.FULL, quality: 30 });
                    await sock.sendMessage(jid, await sticker.toMessage());
                    await sock.sendMessage(jid, { delete: m.key });
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

            case 'editar':
                const instrucao = `📝 *CONFIGURAÇÃO DE PERFIL*\n\nCopie a lista abaixo, preencha seus dados e envie a mensagem contendo o comando *!editapronto* no final.\n\nIdade: \nSexualidade: \nEstado Civil: \nHobbies: \n\n*!editapronto*`;
                await sock.sendMessage(jid, { text: instrucao }, { quoted: m });
                break;

            case 'perfil':
                const target = getMention() || sender;
                const perfil = perfis[target];

                if (!perfil) {
                    return sock.sendMessage(jid, { text: target === sender ? '❌ Você ainda não tem um perfil. Use *!editar* para criar!' : '❌ Este usuário ainda não configurou um perfil.' });
                }

                let ppPerfil;
                try {
                    ppPerfil = await sock.profilePictureUrl(target, 'image');
                } catch {
                    ppPerfil = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
                }

                const textoPerfil = `╭─── [ 👤 *PERFIL DO USUÁRIO* ] ───╮
│
│ 👤 *Nome:* @${target.split('@')[0]}
│ 🎂 *Idade:* ${perfil.idade}
│ 🌈 *Sexualidade:* ${perfil.sexualidade}
│ 💍 *Estado Civil:* ${perfil.estadoCivil}
│ 🎨 *Hobbies:* ${perfil.hobbies}
│
╰──────────────────────────╯`;

                await sock.sendMessage(jid, { 
                    image: { url: ppPerfil }, 
                    caption: textoPerfil, 
                    mentions: [target] 
                }, { quoted: m });
                break;

            case 'iniciar':
                if (jogosAtivos[jid]) return sock.sendMessage(jid, { text: '⚠️ O jogo já está rolando!' });
                await iniciarRodada(sock, jid);
                break;

            case 'stop':
                if (!jogosAtivos[jid]) return sock.sendMessage(jid, { text: '❌ Não há jogo ativo agora.' });
                clearInterval(jogosAtivos[jid].intervalo);
                delete jogosAtivos[jid];
                await sock.sendMessage(jid, { text: '🛑 *O jogo de filmes foi parado.*' });
                break;

            case 'pontos':
                const pts = pontosFilmes[sender] || 0;
                await sock.sendMessage(jid, { text: `🏆 @${sender.split('@')[0]}, você tem *${pts}* pontos!`, mentions: [sender] }, { quoted: m });
                break;

            case 'ping': await sock.sendMessage(jid, { text: '🏓 Pong!' }); break;
            case 'id': await sock.sendMessage(jid, { text: `👤 ID: ${sender}` }); break;
        }
    });
}

startAtrinoBot();