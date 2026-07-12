function criarSessaoTriagem(userJid, grupoJid) {
  return {
    userJid,
    grupoJid,
    imagens: [],
    audios: [],
    finalizada: false,
    criadaEm: new Date().toISOString()
  };
}

function adicionarMidiaTriagem(sessao, tipo, buffer) {
  if (!sessao || !buffer) return null;

  if (tipo === 'image') {
    sessao.imagens.push(buffer);
  } else if (tipo === 'audio') {
    sessao.audios.push(buffer);
  }

  return sessao;
}

function montarResumoTriagem(sessao) {
  if (!sessao) return '';

  const totalImagens = sessao.imagens.length;
  const totalAudios = sessao.audios.length;
  const totalMidias = totalImagens + totalAudios;

  return [
    '📋 *TRIAGEM RECEBIDA*',
    '',
    `👤 Usuário: ${sessao.userJid}`,
    `🖼️ Imagens: ${totalImagens}`,
    `🎧 Áudios: ${totalAudios}`,
    `📦 Total de mídias: ${totalMidias}`,
    '',
    'Aguardando envio do resumo final para o grupo.'
  ].join('\n');
}

module.exports = {
  criarSessaoTriagem,
  adicionarMidiaTriagem,
  montarResumoTriagem
};
