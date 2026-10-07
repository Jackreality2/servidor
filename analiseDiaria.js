const fs = require('fs');
const path = require('path');

const analiseDiaria = {
  registrarMensagem() {},
  registrarComando() {},
  obterMensagens() { return []; },
  obterRelatorio() { return this.obterDia(); },
  obterDia(data) {
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

module.exports = analiseDiaria;
