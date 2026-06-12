const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const cron = require('node-cron'); 
const http = require('http');
const axios = require('axios');
const fs = require('fs');

// --- CORREÇÃO DEFINITIVA DO FFMPEG PARA O RENDER ---
const ffmpegPath = require('ffmpeg-static');
const fluentFfmpeg = require('fluent-ffmpeg');

// Define o caminho do binário estático do ffmpeg-static
fluentFfmpeg.setFfmpegPath(ffmpegPath);

const logger = P({ level: 'silent' });

// --- CONFIGURAÇÕES MASTER ---
const DONO_SUPREMO = '5521983161582@s.whatsapp.net'; 
const DONO_ADMIN = '5521935052708@s.whatsapp.net'; 
const ID_DO_GRUPO = '120363425471646460@g.us';
 
let mutados = [];
let advertencias = {}; 
let historicoComandos = [];
let botSilenciado = false;
let cooldowns = {};
let qrAtual = null; // 🚀 Armazena o QR Code ativo para renderizar na Web do Render
let estatisticas = {};
let contagemAtiva = {};
let saldosUFSC = {};
let anagramaGame = { ativo: false, palavra: "", embaralhada: "", jid: "" };
let notificacoesAtivas = {};
let solicitacoesPendentes = {};
let precoFigurinha = 2;
let ultimaInteracao = {};
let gruposRegistrados = [];

// --- FUNÇÕES DE SINCRONIZAÇÃO GITHUB ---
async function syncGruposToGithub(grupos) {
    const config = { token: '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', owner: 'Jackreality2', repo: 'servidor', path: 'grupos_registrados.json' };
    if (!config.token || !config.owner || !config.repo) return console.log('⚠️ Configurações do GitHub ausentes.');
    
    const headers = { 
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'AtrinoBot-Sync'
    };

    try {
        const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
        let sha;
        try {
            const getFile = await axios.get(url, { headers });
            sha = getFile.data.sha;
        } catch (e) {}

        await axios.put(url, {
            message: `Update registered groups: ${new Date().toISOString()}`,
            content: Buffer.from(JSON.stringify(grupos, null, 2)).toString('base64'),
            sha: sha
        }, { headers });
        
        console.log(`✅ Grupos sincronizados com GitHub. Total: ${grupos.length}`);
    } catch (err) { 
        console.error('❌ Erro GitHub:', err.response?.data?.message || err.message); 
    }
}

async function loadGruposFromGithub() {
    const config = { token: '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', owner: 'Jackreality2', repo: 'servidor', path: 'grupos_registrados.json' };
    if (!config.token || !config.owner || !config.repo) return;
    
    const headers = { 'Authorization': `Bearer ${config.token}`, 'User-Agent': 'AtrinoBot-Sync' };

    try {
        const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
        const res = await axios.get(url, { headers });
        gruposRegistrados = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf-8'));
        console.log('✅ Grupos carregados do GitHub.');
    } catch (e) { console.log('ℹ️ Nenhum registro encontrado no GitHub, iniciando limpo.'); }
}

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
    await loadGruposFromGithub();
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
        // 1. Monitoramento de quem ENTRA (via link ou adicionado diretamente)
        if (anu.action === 'add') {
            if (!notificacoesAtivas[anu.id]) return; // Boas-vindas só se ativado
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
        
        // 2. Monitoramento de SOLICITAÇÕES (Aprovação de novos membros ativa)
        if (anu.action === 'request') {
            const solicitante = anu.participants[0];
            solicitacoesPendentes[anu.id] = solicitante; // Armazena a última solicitação do grupo
            const msgReq = `🔔 *SOLICITAÇÃO DE ENTRADA VIA LINK*\n\n` +
                           `👤 Usuário: @${solicitante.split('@')[0]}\n` +
                           `🔢 Número: ${solicitante.split('@')[0]}\n\n` +
                           `Alguém tentou entrar pelo link do grupo.\n` +
                           `👉 Digite apenas *.aceitar* para permitir.\n` +
                           `👉 Digite apenas *.recusar* para barrar.`;
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

        // --- SISTEMA DE RESET POR INATIVIDADE (5 DIAS) ---
        const agoraInteracao = Date.now();
        const CINCO_DIAS_MS = 5 * 24 * 60 * 60 * 1000;

        if (ultimaInteracao[sender] && (agoraInteracao - ultimaInteracao[sender]) > CINCO_DIAS_MS) {
            saldosUFSC[sender] = 0; // Reset saldo por inatividade
            console.log(`🧹 Saldo de ${sender} resetado por inatividade de 5 dias.`);
        }
        ultimaInteracao[sender] = agoraInteracao; // Atualiza timestamp da última atividade

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
                await sock.sendMessage(jid, { delete: m.key });
                advertencias[sender] = (advertencias[sender] || 0) + 1;
                
                if (advertencias[sender] >= 3) {
                    await sock.sendMessage(jid, { text: `🚫 @${sender.split('@')[0]} insistiu em enviar mensagens silenciado e atingiu 3/3 advertências. Removendo do grupo...`, mentions: [sender] });
                    await sock.groupParticipantsUpdate(jid, [sender], "remove");
                    mutados = mutados.filter(x => x !== sender);
                    delete advertencias[sender];
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]}, você está silenciado! Suas mensagens serão apagadas.\n*Advertência:* ${advertencias[sender]}/3`, mentions: [sender] });
                }
                return;
            } catch (err) {
                console.error("Erro ao processar mensagem de usuário mutado:", err);
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

        // --- BLOQUEIO DE SEGURANÇA: SÓ FUNCIONA SE REGISTRADO ---
        if (!gruposRegistrados.includes(jid) && command !== 'registrar') {
            // Se o grupo não estiver registrado, o bot ignora silenciosamente todos os comandos
            // exceto o próprio comando de registro.
            return;
        }

        // --- LOG DE COMANDO PARA RESPOSTAS ---
        const agoraCmd = new Date();
        const horarioCmd = agoraCmd.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const dataCmd = agoraCmd.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const logComando = `\n\n*COMANDO SOLICITADO POR:* @${sender.split('@')[0]} : ${horarioCmd} : ${dataCmd}`;
        // --- REGISTRO DE HISTÓRICO PARA O RELATÓRIO ---
        const agoraLog = new Date();
        const horarioLog = agoraLog.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const dataLog = agoraLog.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        
        historicoComandos.push({
            comando: command,
            usuario: sender,
            horario: horarioLog,
            data: dataLog
        });
        if (historicoComandos.length > 50) historicoComandos.shift(); // Mantém os últimos 50 comandos

        // --- SISTEMA DE COOLDOWN (10 SEGUNDOS) ---
        const agora = Date.now();
        const tempoEspera = 10000; // 10 segundos em milissegundos
        if (cooldowns[sender] && agora < cooldowns[sender] + tempoEspera) {
            const restante = ((cooldowns[sender] + tempoEspera - agora) / 1000).toFixed(1);
            return await sock.sendMessage(jid, { text: `⏳ *Calma lá!* Aguarde ${restante}s para usar outro comando.` }, { quoted: m });
        }
        cooldowns[sender] = agora;

        // --- COMANDO DINÂMICO DE PREÇO ---
        if (command.startsWith('mudapreço_fig_')) {
            if (!isSenderAdmin) return;
            const novoPreco = parseInt(command.split('_').pop());
            if (isNaN(novoPreco)) return sock.sendMessage(jid, { text: '❌ Valor inválido. Use por exemplo: .mudapreço_fig_20' });
            precoFigurinha = novoPreco;
            return await sock.sendMessage(jid, { text: `✅ O preço das figurinhas foi alterado para: *${precoFigurinha} UFSC*` });
        }

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
│ ➥ .registrar - Ativar bot no grupo
│ ➥ .s - Figurinha (Foto)
│ ➥ .a - Figurinha Animada (Vídeo)
│ ➥ .mat @user - Calcular Match
│
│ 👮 *Admin:*
│ ➥ .cep [cep] - Consulta CEP
│ ➥ .contador - Ativar/Desativar contagem
│ ➥ .citar - Marcar alvo para flood
│ ➥ .doar @user [valor] - Dar moedas
│ ➥ .mudapreço_fig_[valor] - Mudar custo
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
│ ➥ .relatorio - Log de comandos
│ ➥ @name - Mencionar todos
│
╰───────────────────╯`;
                await sock.sendMessage(jid, { text: menu + logComando, mentions: [sender] }, { quoted: m });
                break;

            case 'registrar':
                if (!isSenderAdmin) return;
                if (gruposRegistrados.includes(jid)) {
                    return await sock.sendMessage(jid, { text: '✅ Este grupo já está registrado e ativo!' }, { quoted: m });
                }
                
                await sock.sendMessage(jid, { text: '⏳ *Processando registro e sincronizando com GitHub...*' }, { quoted: m });
                gruposRegistrados.push(jid);
                
                await syncGruposToGithub(gruposRegistrados);
                await sock.sendMessage(jid, { text: '🚀 *GRUPO REGISTRADO COM SUCESSO!*\n\nO bot agora está oficialmente ativo neste salão e salvo na nuvem.' }, { quoted: m });
                break;

            case 'cep':
                if (!isSenderAdmin) return;
                if (!args[0]) return sock.sendMessage(jid, { text: '❌ Informe o CEP!' });
                try {
                    const cepRes = await axios.get(`https://viacep.com.br/ws/${args[0].replace(/\D/g, '')}/json/`);
                    if (cepRes.data.erro) return sock.sendMessage(jid, { text: '❌ CEP não encontrado.' });
                    const infoCep = `📍 *INFORMAÇÕES DO CEP*\n\n` +
                                    `📮 *CEP:* ${cepRes.data.cep}\n` +
                                    `🏘️ *Logradouro:* ${cepRes.data.logradouro}\n` +
                                    `🏢 *Bairro:* ${cepRes.data.bairro}\n` +
                                    `🏙️ *Cidade:* ${cepRes.data.localidade}\n` +
                                    `🗺️ *Estado:* ${cepRes.data.uf}`;
                    await sock.sendMessage(jid, { text: infoCep + logComando });
                } catch (e) {
                    await sock.sendMessage(jid, { text: '❌ Erro ao buscar CEP.' });
                }
                break;

            case 'cpf':
                if (!isSenderAdmin) return;
                if (!args[0]) return sock.sendMessage(jid, { text: '❌ Informe o CPF!' });
                await sock.sendMessage(jid, { text: '🔍 *Buscando dados do CPF no banco de dados...*' });
                try {
                    // Aqui você deve colocar a URL da sua API de consulta (Ex: Painel de busca)
                    // Exemplo: const res = await axios.get(`https://sua-api.com/cpf?numero=${args[0]}`);
                    
                    const layoutCpf = `👤 *CONSULTA CPF*\n\n` +
                                      `📌 *CPF:* ${args[0]}\n` +
                                      `📛 *Nome:* [DADO_DA_API]\n` +
                                      `📅 *Nascimento:* [DADO_DA_API]\n` +
                                      `👩 *Mãe:* [DADO_DA_API]\n\n` +
                                      `⚠️ _Nota: Conecte sua API de consulta no código para retornar dados reais._`;
                    await sock.sendMessage(jid, { text: layoutCpf + logComando });
                } catch (e) {
                    await sock.sendMessage(jid, { text: '❌ Erro ao realizar consulta de CPF.' });
                }
                break;

            case 'nomecompleto':
            case 'nome':
                if (!isSenderAdmin) return;
                if (args.length === 0) return sock.sendMessage(jid, { text: '❌ Informe o nome completo!' });
                const nomeBusca = args.join(' ');
                await sock.sendMessage(jid, { text: `🔍 *Buscando registros para:* ${nomeBusca}...` });
                try {
                    const layoutNome = `🗂️ *RESULTADOS POR NOME*\n\n` +
                                       `🔎 *Termo:* ${nomeBusca}\n` +
                                       `📝 *Registros:* [DADOS_DA_API]\n\n` +
                                       `⚠️ _Nota: Conecte sua API de consulta no código._`;
                    await sock.sendMessage(jid, { text: layoutNome + logComando });
                } catch (e) {
                    await sock.sendMessage(jid, { text: '❌ Erro ao realizar consulta por nome.' });
                }
                break;     
            case 's':
            case 'sticker':
                try {
                    // Verificação de Saldo (Custo Dinâmico)
                    if ((saldosUFSC[sender] || 0) < precoFigurinha) {
                        return sock.sendMessage(jid, { text: `❌ *SALDO INSUFICIENTE*\n\nVocê precisa de pelo menos *${precoFigurinha} UFSC* para criar uma figurinha.\n💰 Seu saldo atual: ${saldosUFSC[sender] || 0} UFSC.\n\n🎮 Jogue o anagrama (.ativar_anagrama) para ganhar moedas!` }, { quoted: m });
                    }

                    const quotedS = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const imgS = m.message.imageMessage || quotedS?.imageMessage;

                    if (imgS) {
                        // Apaga a mensagem independente de ter saldo ou não
                        try { await sock.sendMessage(jid, { delete: m.key }); } catch {}

                        // Verificação de Saldo (Custo Dinâmico)
                        if ((saldosUFSC[sender] || 0) < precoFigurinha) {
                            return sock.sendMessage(jid, { text: `❌ *SALDO INSUFICIENTE*\n\nVocê precisa de pelo menos *${precoFigurinha} UFSC* para criar uma figurinha.\n💰 Seu saldo atual: ${saldosUFSC[sender] || 0} UFSC.\n\n🎮 Jogue o anagrama (.ativar_anagrama) para ganhar moedas!${logComando}`, mentions: [sender] });
                        }

                        const stream = await downloadContentFromMessage(imgS, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        
                        const sticker = new Sticker(buffer, { pack: 'Atrino Bot', author: 'Garibaldo356', type: StickerTypes.FULL });
                        await sock.sendMessage(jid, await sticker.toMessage());
                        
                        saldosUFSC[sender] -= precoFigurinha; // Deduz o custo
                        await sock.sendMessage(jid, { text: `✅ Figurinha criada! 💰 Seu saldo atual: *${saldosUFSC[sender]} UFSC*` });
                        
                        try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
                    } else {
                        await sock.sendMessage(jid, { text: '❌ Envie uma foto ou responda a uma com .s' + logComando, mentions: [sender] });
                        
                        try {
                            await sock.sendMessage(jid, { delete: m.key });
                        } catch (delErr) {
                            console.log('Erro ao deletar imagem (Verifique se o bot é Admin):', delErr.message);
                        }
                    }
                } catch (stkErr) {
                    console.error('Erro no comando de sticker:', stkErr);
                    await sock.sendMessage(jid, { text: '❌ Erro ao criar figurinha. Suas moedas não foram descontadas.' });
                }
                break;

            case 'a':
            case 'animada':
                try {
                    // Verificação de Saldo (Custo Dinâmico)
                    if ((saldosUFSC[sender] || 0) < precoFigurinha) {
                        return sock.sendMessage(jid, { text: `❌ *SALDO INSUFICIENTE*\n\nVocê precisa de pelo menos *${precoFigurinha} UFSC* para criar uma figurinha animada.\n💰 Seu saldo atual: ${saldosUFSC[sender] || 0} UFSC.` }, { quoted: m });
                    }

                    const quotedA = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const vidA = m.message.videoMessage || quotedA?.videoMessage;
                    
                    if (vidA) {
                        // Apaga a mensagem independente de ter saldo ou não
                        try { await sock.sendMessage(jid, { delete: m.key }); } catch {}

                        // Verificação de Saldo (Custo Dinâmico)
                        if ((saldosUFSC[sender] || 0) < precoFigurinha) {
                            return sock.sendMessage(jid, { text: `❌ *SALDO INSUFICIENTE*\n\nVocê precisa de pelo menos *${precoFigurinha} UFSC* para criar uma figurinha animada.\n💰 Seu saldo atual: ${saldosUFSC[sender] || 0} UFSC.${logComando}`, mentions: [sender] });
                        }

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
                        
                        saldosUFSC[sender] -= precoFigurinha; // Deduz o custo
                        await sock.sendMessage(jid, { text: `✅ Figurinha animada criada! 💰 Seu saldo atual: *${saldosUFSC[sender]} UFSC*` }, { quoted: m });
                        
                        try { await sock.sendMessage(jid, { delete: m.key }); } catch {}
                    } else {
                        await sock.sendMessage(jid, { text: '❌ Responda a um vídeo ou envie um com o comando .a para fazer uma figurinha animada!' }, { quoted: m });
                    }
                } catch (err) {
                    console.error('Erro no comando .a:', err);
                    await sock.sendMessage(jid, { text: '❌ Erro ao converter vídeo para figurinha. Suas moedas não foram descontadas.' });
                }
                break;

            case 'mat':
            case 'match':
                try {
                    // Verificação de Saldo (Custo Dinâmico igual figurinha)
                    const saldoAtual = saldosUFSC[sender] || 0;
                    if (saldoAtual < precoFigurinha) {
                        return sock.sendMessage(jid, { text: `❌ *SALDO INSUFICIENTE*\n\nO custo do Match é *${precoFigurinha} UFSC*.\n💰 Seu saldo atual: ${saldoAtual} UFSC.` }, { quoted: m });
                    }

                    let t1, t2;
                    const mentionsMatch = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

                    if (body.toLowerCase().includes('@eu') || body.toLowerCase().includes(' eu ')) {
                        t1 = sender;
                        t2 = mentionsMatch.find(v => v !== sender) || mentionsMatch[0];
                    } else {
                        t1 = mentionsMatch[0];
                        t2 = mentionsMatch[1];
                    }

                    if (!t1 || !t2 || t1 === t2) {
                        return sock.sendMessage(jid, { text: '❌ *ERRO DE ALVO*\n\nUse: .mat @eu @pessoa\nOu: .mat @pessoa1 @pessoa2' }, { quoted: m });
                    }

                    const lovePerc = Math.floor(Math.random() * 101);
                    let coracao = lovePerc > 75 ? "❤️‍🔥" : lovePerc > 50 ? "💖" : lovePerc > 25 ? "🧡" : "💔";
                    
                    let fraseAmor = lovePerc > 85 ? " UM CASAL LENDÁRIO! A química é absoluta." : 
                                    lovePerc > 60 ? "💖 Tem muito futuro! O cupido acertou em cheio." : 
                                    lovePerc > 40 ? "⚖️ Tem chance, mas precisam sair do zero a zero." : 
                                    "📉 A vibe não bateu... Melhor ficarem na amizade.";

                    saldosUFSC[sender] -= precoFigurinha; // Deduz o custo

                    const layoutMatch = `✨ 💘 *ORÁCULO DO AMOR* 💘 ✨\n` +
                                      `━━━━━━━━━━━━━━━━━\n\n` +
                                      `👤 @${t1.split('@')[0]}\n` +
                                      `      ${coracao} *${lovePerc}%* ${coracao}\n` +
                                      `👤 @${t2.split('@')[0]}\n\n` +
                                      `📝 *Veredito:* ${fraseAmor}\n\n` +
                                      `━━━━━━━━━━━━━━━━━\n` +
                                      `💰 *Custo:* ${precoFigurinha} UFSC\n` +
                                      `💰 *Saldo atual:* ${saldosUFSC[sender]} UFSC`;

                    await sock.sendMessage(jid, { 
                        text: layoutMatch,
                        mentions: [t1, t2]
                    }, { quoted: m });

                } catch (err) {
                    console.error('Erro no comando match:', err);
                    await sock.sendMessage(jid, { text: '❌ Erro ao processar o Match. Suas moedas não foram descontadas.' });
                }
                break;

            case 'tornaadm':
                if (!isSenderAdmin) return;
                const userToAdmin = getMention();
                if (!userToAdmin) return sock.sendMessage(jid, { text: '❌ Mencione alguém!' });
                await sock.groupParticipantsUpdate(jid, [userToAdmin], "promote");
                await sock.sendMessage(jid, { text: `✅ @${userToAdmin.split('@')[0]} agora é Admin!`, mentions: [userToAdmin] });
                break;

            case 'relatorio':
                if (!isSenderAdmin) return;
                // Reação inicial com emoji de positivo
                await sock.sendMessage(jid, { react: { text: '👍', key: m.key } });

                let relTexto = "📋 *RELATÓRIO DE COMANDOS EXECUTADOS*\n\n";
                if (historicoComandos.length === 0) {
                    relTexto += "_Nenhum comando registrado no histórico._";
                } else {
                    historicoComandos.forEach((h, i) => {
                        relTexto += `${i + 1}. .${h.comando} - @${h.usuario.split('@')[0]} : ${h.horario} : ${h.data}\n`;
                    });
                }

                // Proteção contra limite de caracteres (3900)
                if (relTexto.length > 3800) {
                    relTexto = relTexto.substring(0, 3800) + "\n\n⚠️ *O relatório foi encurtado por ser muito longo.*";
                }

                const buttons = [
                    { buttonId: '.relpdf', buttonText: { displayText: '📄 Transformar em PDF' }, type: 1 }
                ];

                await sock.sendMessage(jid, { 
                    text: relTexto, 
                    footer: 'Atrino Bot - Sistema de Auditoria',
                    buttons: buttons,
                    headerType: 1,
                    mentions: historicoComandos.map(h => h.usuario)
                });
                break;

            case 'relpdf':
                if (!isSenderAdmin) return;
                let contentPdf = "📋 RELATÓRIO DE COMANDOS - ATRINO BOT\n" + "=".repeat(40) + "\n\n";
                historicoComandos.forEach((h, i) => {
                    contentPdf += `${i + 1}. Comando: .${h.comando}\n   Usuário: ${h.usuario}\n   Data: ${h.data} | Hora: ${h.horario}\n\n`;
                });
                
                await sock.sendMessage(jid, { 
                    document: Buffer.from(contentPdf), 
                    mimetype: 'application/pdf', 
                    fileName: 'relatorio_comandos.pdf',
                    caption: '✅ Aqui está o seu relatório detalhado em PDF.'
                });
                break;

            case 'mute':
                if (!isSenderAdmin || !getMention()) return;
                const userMute = getMention();
                if (!mutados.includes(userMute)) mutados.push(userMute);
                await sock.sendMessage(jid, { text: `🤫 @${userMute.split('@')[0]} foi silenciado. Qualquer mensagem enviada agora resultará em advertência!`, mentions: [userMute] });
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

                if (textT.length > 3800) {
                    textT = textT.substring(0, 3800) + "\n\n⚠️ *Lista encurtada devido ao limite de caracteres.*";
                }

                await sock.sendMessage(jid, { text: textT, mentions: mnts });
                break;

            case 'abrir':
                if (!isSenderAdmin) return;
                await sock.groupSettingUpdate(jid, 'not_announcement');
                await sock.sendMessage(jid, { text: '✅ *AGORA TODOS PODEM ENVIAR MENSAGEM*' });
                break;

            case 'fechar':
                if (!isSenderAdmin) return;
                await sock.groupSettingUpdate(jid, 'announcement');
                await sock.sendMessage(jid, { text: '❌ *AGORA APENAS ADMINISTRADORES PODEM ENVIAR MENSAGEM*' });
                break;

            case 'ban':
                if (!isSenderAdmin) return;
                const userBan = getMention();
                if (!userBan) return sock.sendMessage(jid, { text: '❌ Mencione o usuário que deseja banir!' });
                
                const motivoBan = args.join(' ').replace(/@\d+/g, '').trim() || "Sem motivo especificado";
                
                await sock.sendMessage(jid, { 
                    text: `🚫 *USUÁRIO EXPULSO*\n\n👤 Usuário: @${userBan.split('@')[0]}\n📝 Motivo: ${motivoBan}\n\nO usuário foi removido do grupo.`, 
                    mentions: [userBan] 
                });
                await sock.groupParticipantsUpdate(jid, [userBan], "remove");
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
                let userAcc = getMention() || solicitacoesPendentes[jid];
                
                // Se não tiver na memória, busca direto no servidor do WhatsApp
                if (!userAcc) {
                    try {
                        const requests = await sock.groupRequestParticipantsList(jid);
                        if (requests && requests.length > 0) {
                            userAcc = requests[0].jid; // Pega o primeiro da fila
                        }
                    } catch (e) {
                        console.error("Erro ao buscar lista de pedidos:", e);
                    }
                }

                if (!userAcc) return sock.sendMessage(jid, { text: '❌ Não há solicitações pendentes para este grupo no momento.' });
                
                try {
                    await sock.groupRequestParticipantsUpdate(jid, [userAcc], "approve");
                    await sock.sendMessage(jid, { text: `✅ A solicitação de @${userAcc.split('@')[0]} foi aprovada com sucesso!`, mentions: [userAcc] });
                    delete solicitacoesPendentes[jid]; // Limpa após processar
                } catch (err) {
                    await sock.sendMessage(jid, { text: '❌ Erro ao processar: a solicitação pode ter expirado ou o usuário cancelou.' });
                }
                break;

            case 'recusar':
                if (!isSenderAdmin) return;
                let userRec = getMention() || solicitacoesPendentes[jid];

                if (!userRec) {
                    try {
                        const requests = await sock.groupRequestParticipantsList(jid);
                        if (requests && requests.length > 0) {
                            userRec = requests[0].jid;
                        }
                    } catch (e) {}
                }

                if (!userRec) return sock.sendMessage(jid, { text: '❌ Não há solicitações pendentes para este grupo no momento.' });

                await sock.groupRequestParticipantsUpdate(jid, [userRec], "reject");
                await sock.sendMessage(jid, { text: `🚫 A solicitação de @${userRec.split('@')[0]} foi recusada.`, mentions: [userRec] });
                delete solicitacoesPendentes[jid]; // Limpa após processar
                break;

            case 'doar':
                if (!isSenderAdmin) return;
                const userDoar = getMention();
                const valorDoar = parseInt(args[1]);

                if (!userDoar) return sock.sendMessage(jid, { text: '❌ Mencione o usuário que receberá as moedas!' }, { quoted: m });
                if (isNaN(valorDoar)) return sock.sendMessage(jid, { text: '❌ Valor inválido! Use: .doar @user 400' }, { quoted: m });

                saldosUFSC[userDoar] = (saldosUFSC[userDoar] || 0) + valorDoar;
                await sock.sendMessage(jid, { 
                    text: `💰 *DOAÇÃO REALIZADA!*\n\n👤 Beneficiário: @${userDoar.split('@')[0]}\n🪙 Valor: ${valorDoar} UFSC\n📈 Novo saldo: ${saldosUFSC[userDoar]} UFSC`,
                    mentions: [userDoar] 
                }, { quoted: m });
                break;

            case 'citar':
                if (!isSenderAdmin) return;
                const contextCitar = m.message.extendedTextMessage?.contextInfo;
                if (!contextCitar || !contextCitar.stanzaId) {
                    return sock.sendMessage(jid, { text: '❌ Responda a uma mensagem para usar o .citar!' }, { quoted: m });
                }

                const targetParticipant = contextCitar.participant || contextCitar.remoteJid;
                await sock.sendMessage(jid, { text: 'FLOODEM , INVADA AGORA' }, { 
                    quoted: { 
                        key: {
                            remoteJid: jid,
                            fromMe: targetParticipant === jidNormalizedUser(sock.user.id),
                            id: contextCitar.stanzaId,
                            participant: targetParticipant
                        }, 
                        message: contextCitar.quotedMessage 
                    } 
                });
                break;
        }
    });
}

startAtrinoBot();
