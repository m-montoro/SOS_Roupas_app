const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, ClipboardItem, nativeImage, session } = require('electron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const database = require('./database');

let mainWindow;
const db = () => database.db;

// Os dados ficam SEMPRE em %APPDATA%\\sos-roupas-app, tanto rodando com `npm start` quanto no app instalado.
// MODO DEMONSTRAÇÃO: se a variável SOS_ROUPAS_DADOS apontar para uma pasta, o sistema usa um banco
// separado e vazio nela (útil para gravar vídeos/prints sem mostrar clientes reais).
const pastaDemo = process.env.SOS_ROUPAS_DADOS ? path.resolve(process.env.SOS_ROUPAS_DADOS) : null;
const pastaDados = pastaDemo || path.join(app.getPath('appData'), 'sos-roupas-app');
fs.mkdirSync(pastaDados, { recursive: true });
app.setPath('userData', pastaDados);

// Ícone do app (barra de tarefas / janela). No app instalado o .ico fica na pasta de recursos
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

const EMPRESAS = ['SOS Roupas', "Bruan's...", 'MB Fitness'];
const STATUS_PECA = ['A fazer', 'Em Produção', 'Pronta'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Agrupa corretamente o ícone na barra de tarefas do Windows
app.setAppUserModelId('br.com.sosroupas.gestao');

// Se algo falhar, mostra uma janela com o erro (em vez de o app "não abrir" sem explicação)
function mostrarErro(titulo, err) {
  const msg = err && err.stack ? err.stack : String(err);
  console.error(titulo, msg);
  try { dialog.showErrorBox(titulo, msg); } catch (e) { /* ignora */ }
}
process.on('uncaughtException', (err) => mostrarErro('Erro inesperado no SOS Roupas', err));
process.on('unhandledRejection', (err) => mostrarErro('Erro inesperado no SOS Roupas', err));

// ---------- Datas no fuso LOCAL (toISOString usa UTC e erra a data à noite no Brasil) ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function hojeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function stampLocal() {
  const d = new Date();
  return `${hojeLocal()}_${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
}

// 'YYYY-MM' + N meses (a virada de ano é tratada por aritmética: dez/2026 + 1 = jan/2027)
function somarMeses(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: pastaDemo ? 'SOS ROUPAS — Gestão (MODO DEMONSTRAÇÃO — dados separados)' : 'SOS ROUPAS — Gestão',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // SEGURANÇA: a janela só mostra a tela local do sistema. Nada de abrir sites/janelas dentro do app
  // (a tela tem acesso ao Node; carregar conteúdo externo nela seria perigoso).
  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    mostrarErro('Não foi possível carregar a tela do sistema', `${desc} (código ${code})`);
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    mostrarErro('A tela do sistema parou de funcionar', details && details.reason);
  });
}

app.whenReady().then(() => {
  // SEGURANÇA: o sistema não precisa de câmera, microfone, localização, notificações etc. Nega tudo.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  try {
    database.initDb();
  } catch (err) {
    mostrarErro('Não foi possível abrir o banco de dados', err);
    app.quit();
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ==========================================
// IPC HANDLERS (COMUNICAÇÃO BANCO / FRONT-END)
// ==========================================

// Dashboard (recebe o mês selecionado no formato 'YYYY-MM')
ipcMain.handle('get-dashboard-stats', (event, mesParam) => {
  const hoje = hojeLocal();
  const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(mesParam || '') ? mesParam : hoje.slice(0, 7);
  const one = (sql, ...p) => db().prepare(sql).get(...p);
  const all = (sql, ...p) => db().prepare(sql).all(...p);
  const dtEntrada = "COALESCE(data_entrada, substr(criado, 1, 10))";

  // --- situação atual (não depende do mês) ---
  const totalClientes = one('SELECT COUNT(*) AS n FROM clientes').n;
  const porStatus = (st) => one('SELECT COUNT(*) AS n FROM ordens WHERE status = ?', st).n;
  const abertas = porStatus('Aguardando');
  const producao = porStatus('Em Produção');
  const prontas = porStatus('Pronto');
  const atrasadas = one(
    "SELECT COUNT(*) AS n FROM ordens WHERE data_entrega < ? AND status NOT IN ('Entregue', 'Cancelado')", hoje
  ).n;
  const aReceber = one("SELECT COALESCE(SUM(saldo), 0) AS t FROM ordens WHERE status != 'Cancelado'").t;

  // --- resumo do mês selecionado ---
  const faturamento = one(
    'SELECT COALESCE(SUM(valor), 0) AS t FROM pagamentos WHERE substr(data_pagamento, 1, 7) = ?', mes
  ).t;
  const osMes = one(
    `SELECT COUNT(*) AS n, COALESCE(AVG(valor_total), 0) AS media FROM ordens
     WHERE substr(${dtEntrada}, 1, 7) = ? AND status != 'Cancelado'`, mes
  );
  const entregasMes = one(
    "SELECT COUNT(*) AS n FROM ordens WHERE substr(data_entrega, 1, 7) = ? AND status != 'Cancelado'", mes
  ).n;
  const novosClientes = one('SELECT COUNT(*) AS n FROM clientes WHERE substr(cadastro, 1, 7) = ?', mes).n;

  // --- gráficos ---
  const [ano, mm] = mes.split('-').map(Number);
  const diasNoMes = new Date(ano, mm, 0).getDate();
  const mapaDia = Object.fromEntries(all(
    `SELECT substr(data_pagamento, 9, 2) AS d, SUM(valor) AS t FROM pagamentos
     WHERE substr(data_pagamento, 1, 7) = ? GROUP BY d`, mes
  ).map((r) => [Number(r.d), r.t]));
  const porDia = Array.from({ length: diasNoMes }, (_, i) => ({ dia: i + 1, total: mapaDia[i + 1] || 0 }));

  const inicio12 = somarMeses(mes, -11);
  const mapaMes = Object.fromEntries(all(
    `SELECT substr(data_pagamento, 1, 7) AS m, SUM(valor) AS t FROM pagamentos
     WHERE substr(data_pagamento, 1, 7) BETWEEN ? AND ? GROUP BY m`, inicio12, mes
  ).map((r) => [r.m, r.t]));
  const ultimos12 = Array.from({ length: 12 }, (_, i) => {
    const m = somarMeses(inicio12, i);
    return { mes: m, total: mapaMes[m] || 0 };
  });

  const formas = all(
    `SELECT forma_pagamento AS forma, SUM(valor) AS total FROM pagamentos
     WHERE substr(data_pagamento, 1, 7) = ? GROUP BY forma_pagamento ORDER BY total DESC`, mes
  );
  const statusMes = all(
    `SELECT status, COUNT(*) AS qtd FROM ordens WHERE substr(${dtEntrada}, 1, 7) = ? GROUP BY status ORDER BY qtd DESC`, mes
  );
  const servicos = all(
    `SELECT COALESCE(NULLIF(i.tipo, ''), 'Sem tipo') AS nome, SUM(i.qtd) AS qtd
     FROM os_itens i JOIN ordens o ON o.id = i.os_id
     WHERE substr(COALESCE(o.data_entrada, substr(o.criado, 1, 10)), 1, 7) = ? AND o.status != 'Cancelado'
     GROUP BY nome ORDER BY qtd DESC LIMIT 6`, mes
  );

  // primeiro ano com movimento (para o seletor de ano)
  const anos = [
    one('SELECT MIN(substr(data_pagamento, 1, 4)) AS a FROM pagamentos').a,
    one(`SELECT MIN(substr(${dtEntrada}, 1, 4)) AS a FROM ordens`).a,
    String(ano), hoje.slice(0, 4)
  ].filter(Boolean).map(Number);
  const anoMin = Math.min(...anos);

  return {
    mes, hoje, anoMin,
    totalClientes, abertas, producao, prontas, atrasadas, aReceber,
    faturamento, osMes: osMes.n, ticketMedio: osMes.media, entregasMes, novosClientes,
    porDia, ultimos12, formas, statusMes, servicos
  };
});

// ----- Clientes -----
ipcMain.handle('get-clientes', () => {
  return db().prepare('SELECT * FROM clientes ORDER BY nome COLLATE NOCASE ASC').all();
});

ipcMain.handle('salvar-cliente', (event, cli) => {
  if (cli.id) {
    // As OS guardam uma cópia do nome/telefone; ao editar o cliente, atualiza essa cópia também
    // (senão o WhatsApp e a imagem da OS continuariam usando o telefone antigo).
    const tx = db().transaction(() => {
      db().prepare('UPDATE clientes SET nome=?, tel=?, endereco=?, cidade=?, obs=?, medidas=? WHERE id=?')
        .run(cli.nome, cli.tel, cli.endereco, cli.cidade, cli.obs, cli.medidas, cli.id);
      db().prepare('UPDATE ordens SET cliente_nome = ?, cliente_tel = ? WHERE cliente_id = ?')
        .run(cli.nome, cli.tel, cli.id);
    });
    tx();
    return { success: true, id: Number(cli.id) };
  }
  const r = db().prepare('INSERT INTO clientes (nome, tel, endereco, cidade, obs, medidas) VALUES (?, ?, ?, ?, ?, ?)')
    .run(cli.nome, cli.tel, cli.endereco, cli.cidade, cli.obs, cli.medidas);
  return { success: true, id: Number(r.lastInsertRowid) };
});

ipcMain.handle('deletar-cliente', (event, id) => {
  // Mantém o histórico das OS (que já guardam nome/telefone) e só desvincula o cliente.
  const tx = db().transaction(() => {
    db().prepare('UPDATE ordens SET cliente_id = NULL WHERE cliente_id = ?').run(id);
    db().prepare('DELETE FROM clientes WHERE id = ?').run(id);
  });
  tx();
  return { success: true };
});

// ----- Ordens de Serviço -----
// Lista de OS já com o necessário para buscar e filtrar na tela (peças, empresas, progresso, preço a definir)
ipcMain.handle('get-ordens', () => {
  const ordens = db().prepare('SELECT * FROM ordens ORDER BY id DESC').all();
  const itens = db().prepare('SELECT * FROM os_itens ORDER BY id ASC').all();
  const adic = db().prepare('SELECT item_id, descricao, valor FROM os_servicos_adicionais ORDER BY id ASC').all();

  const adicPorItem = {};
  for (const a of adic) (adicPorItem[a.item_id] = adicPorItem[a.item_id] || []).push(a);
  const itensPorOS = {};
  for (const it of itens) (itensPorOS[it.os_id] = itensPorOS[it.os_id] || []).push(it);

  for (const o of ordens) {
    const lista = itensPorOS[o.id] || [];
    const empresas = new Set();
    const textos = [];
    let semPreco = 0, prontas = 0;
    for (const it of lista) {
      const extras = adicPorItem[it.id] || [];
      const sub = (it.qtd || 1) * (it.valor || 0) + extras.reduce((t, a) => t + (a.valor || 0), 0);
      if (!(sub > 0)) semPreco++;
      if (it.status === 'Pronta') prontas++;
      empresas.add(it.empresa || EMPRESAS[0]);
      textos.push([it.peca, it.cor, it.tipo, it.servico, it.obs, ...extras.map((a) => a.descricao)].filter(Boolean).join(' '));
    }
    o.pecas_total = lista.length;
    o.pecas_prontas = prontas;
    o.sem_preco = semPreco;
    o.empresas = [...empresas];
    o.texto = textos.join(' | ');
  }
  return ordens;
});

// Itens de uma OS, já com os serviços adicionais de cada peça
function carregarItens(osId) {
  const itens = db().prepare('SELECT * FROM os_itens WHERE os_id = ? ORDER BY id ASC').all(osId);
  const adic = db().prepare('SELECT descricao, valor FROM os_servicos_adicionais WHERE item_id = ? ORDER BY id ASC');
  itens.forEach((it, i) => {
    it.numero = i + 1;
    it.empresa = it.empresa || EMPRESAS[0];
    it.obs = it.obs || '';
    it.status = STATUS_PECA.includes(it.status) ? it.status : 'A fazer';
    it.adicionais = adic.all(it.id);
    it.subtotal = r2((it.qtd || 1) * (it.valor || 0) + it.adicionais.reduce((t, a) => t + (a.valor || 0), 0));
  });
  return itens;
}

ipcMain.handle('get-os-detalhes', (event, id) => {
  const os = db().prepare('SELECT * FROM ordens WHERE id = ?').get(id);
  if (!os) return null;
  const itens = carregarItens(id);
  const pagamentos = db().prepare('SELECT * FROM pagamentos WHERE os_id = ? ORDER BY id ASC').all(id);
  return { os, itens, pagamentos };
});

ipcMain.handle('salvar-os', (event, os) => {
  // Normaliza as peças e calcula o total AQUI (não confia no valor calculado na tela)
  const pecas = (Array.isArray(os.pecas) ? os.pecas : []).map((p) => ({
    tipo: String(p.tipo || ''),
    servico: String(p.servico || ''),
    peca: String(p.peca || '').trim(),
    cor: String(p.cor || '').trim(),
    qtd: Math.max(parseInt(p.qtd, 10) || 1, 1),
    valor: r2(p.valor),
    obs: String(p.obs || '').trim(),
    empresa: EMPRESAS.includes(p.empresa) ? p.empresa : EMPRESAS[0],
    adicionais: (Array.isArray(p.adicionais) ? p.adicionais : [])
      .map((a) => ({ descricao: String(a.descricao || '').trim(), valor: r2(a.valor) }))
      .filter((a) => a.descricao)
  }));
  if (!pecas.length) throw new Error('Adicione ao menos uma peça.');

  const valorTotal = r2(pecas.reduce(
    (t, p) => t + p.qtd * p.valor + p.adicionais.reduce((s, a) => s + a.valor, 0), 0
  ));
  const sinal = r2(os.sinal);
  if (sinal < 0) throw new Error('O sinal não pode ser negativo.');
  // Se alguma peça ainda está "a definir", o total é provisório e o cliente pode deixar um sinal maior que ele
  const semPreco = pecas.some((p) => !(p.qtd * p.valor + p.adicionais.reduce((t, a) => t + a.valor, 0) > 0));
  if (sinal > valorTotal && !semPreco) throw new Error('O sinal não pode ser maior que o valor total.');
  const saldo = r2(Math.max(valorTotal - sinal, 0));

  const tx = db().transaction(() => {
    // Número baseado no maior id (COUNT(*) repetia números e quebrava o UNIQUE)
    const proximo = db().prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ordens').get().n;
    const numeroOs = 'OS #' + String(proximo).padStart(3, '0');

    const result = db().prepare(`
      INSERT INTO ordens
        (numero, cliente_id, cliente_nome, cliente_tel, valor_total, sinal, saldo, data_entrada, data_entrega, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Aguardando')
    `).run(
      numeroOs,
      os.cliente_id || null,
      os.cliente_nome,
      os.cliente_tel || '',
      valorTotal,
      sinal,
      saldo,
      hojeLocal(),
      os.data_entrega
    );
    const osId = Number(result.lastInsertRowid);

    const insertPeca = db().prepare(`
      INSERT INTO os_itens (os_id, tipo, servico, peca, cor, qtd, valor, obs, empresa, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'A fazer')
    `);
    const insertAdic = db().prepare('INSERT INTO os_servicos_adicionais (item_id, descricao, valor) VALUES (?, ?, ?)');
    for (const p of pecas) {
      const r = insertPeca.run(osId, p.tipo, p.servico, p.peca, p.cor, p.qtd, p.valor, p.obs, p.empresa);
      for (const a of p.adicionais) insertAdic.run(Number(r.lastInsertRowid), a.descricao, a.valor);
    }

    if (sinal > 0) {
      db().prepare('INSERT INTO pagamentos (os_id, valor, forma_pagamento) VALUES (?, ?, ?)')
        .run(osId, sinal, os.forma_sinal || 'Pix');
    }

    return { success: true, osId, numeroOs, valorTotal };
  });

  return tx();
});

const STATUS_VALIDOS = ['Aguardando', 'Em Produção', 'Pronto', 'Entregue', 'Cancelado'];

ipcMain.handle('atualizar-status-os', (event, { id, status }) => {
  if (!STATUS_VALIDOS.includes(status)) throw new Error('Status inválido: ' + status);
  db().transaction(() => {
    db().prepare('UPDATE ordens SET status = ? WHERE id = ?').run(status, id);
    // OS pronta ou entregue = todas as peças já feitas
    if (status === 'Pronto' || status === 'Entregue') {
      db().prepare("UPDATE os_itens SET status = 'Pronta' WHERE os_id = ?").run(id);
    }
  })();
  return { success: true };
});

// Mantém o status da OS coerente com o das peças (não mexe em OS entregue ou cancelada):
//   todas prontas -> "Pronto"; alguma iniciada/pronta -> "Em Produção"; nenhuma iniciada e estava "Pronto" -> "Aguardando"
function sincronizarStatusOS(osId) {
  const os = db().prepare('SELECT status FROM ordens WHERE id = ?').get(osId);
  if (!os || os.status === 'Entregue' || os.status === 'Cancelado') return os ? os.status : null;
  const sts = db().prepare('SELECT status FROM os_itens WHERE os_id = ?').all(osId).map((x) => x.status || 'A fazer');
  if (!sts.length) return os.status;

  const todas = sts.every((s) => s === 'Pronta');
  const algumaIniciada = sts.some((s) => s !== 'A fazer');
  let novo = os.status;
  if (todas) novo = 'Pronto';
  else if (algumaIniciada && (os.status === 'Aguardando' || os.status === 'Pronto')) novo = 'Em Produção';
  else if (!algumaIniciada && os.status === 'Pronto') novo = 'Aguardando';

  if (novo !== os.status) db().prepare('UPDATE ordens SET status = ? WHERE id = ?').run(novo, osId);
  return novo;
}

// Troca o status de UMA peça (salva na hora) e devolve o status resultante da OS
ipcMain.handle('atualizar-status-peca', (event, { item_id, status }) => {
  if (!STATUS_PECA.includes(status)) throw new Error('Status da peça inválido: ' + status);
  const it = db().prepare('SELECT os_id FROM os_itens WHERE id = ?').get(item_id);
  if (!it) throw new Error('Peça não encontrada.');
  return db().transaction(() => {
    db().prepare('UPDATE os_itens SET status = ? WHERE id = ?').run(status, item_id);
    const osStatus = sincronizarStatusOS(it.os_id);
    const sts = db().prepare('SELECT status FROM os_itens WHERE os_id = ?').all(it.os_id);
    return { success: true, osStatus, pecasTotal: sts.length, pecasProntas: sts.filter((x) => x.status === 'Pronta').length };
  })();
});

// Edita uma OS existente: preços, quantidades, observações, empresa, serviços adicionais e data de entrega.
// Os totais são sempre recalculados aqui; "pago" vem dos pagamentos já registrados.
ipcMain.handle('atualizar-os', (event, dados) => {
  const os = db().prepare('SELECT * FROM ordens WHERE id = ?').get(dados && dados.id);
  if (!os) throw new Error('OS não encontrada.');
  if (dados.data_entrega && !/^\d{4}-\d{2}-\d{2}$/.test(dados.data_entrega)) throw new Error('Data de entrega inválida.');

  const existentes = new Set(db().prepare('SELECT id FROM os_itens WHERE os_id = ?').all(os.id).map((r) => r.id));
  const pecas = (Array.isArray(dados.pecas) ? dados.pecas : []).map((p) => {
    if (!existentes.has(Number(p.id))) throw new Error('Peça não pertence a esta OS.');
    const valor = r2(p.valor);
    if (valor < 0) throw new Error('O preço não pode ser negativo.');
    const adicionais = (Array.isArray(p.adicionais) ? p.adicionais : [])
      .map((a) => ({ descricao: String(a.descricao || '').trim(), valor: r2(a.valor) }))
      .filter((a) => a.descricao);
    if (adicionais.some((a) => a.valor < 0)) throw new Error('O preço não pode ser negativo.');
    return {
      id: Number(p.id),
      tipo: String(p.tipo || ''), servico: String(p.servico || ''),
      peca: String(p.peca || '').trim(), cor: String(p.cor || '').trim(),
      qtd: Math.max(parseInt(p.qtd, 10) || 1, 1), valor,
      obs: String(p.obs || '').trim(),
      empresa: EMPRESAS.includes(p.empresa) ? p.empresa : EMPRESAS[0],
      status: STATUS_PECA.includes(p.status) ? p.status : 'A fazer',
      adicionais
    };
  });

  return db().transaction(() => {
    const upd = db().prepare(`UPDATE os_itens SET tipo=?, servico=?, peca=?, cor=?, qtd=?, valor=?, obs=?, empresa=?, status=?
                              WHERE id = ? AND os_id = ?`);
    const delAdic = db().prepare('DELETE FROM os_servicos_adicionais WHERE item_id = ?');
    const insAdic = db().prepare('INSERT INTO os_servicos_adicionais (item_id, descricao, valor) VALUES (?, ?, ?)');
    for (const p of pecas) {
      upd.run(p.tipo, p.servico, p.peca, p.cor, p.qtd, p.valor, p.obs, p.empresa, p.status, p.id, os.id);
      delAdic.run(p.id);
      for (const a of p.adicionais) insAdic.run(p.id, a.descricao, a.valor);
    }

    // total recalculado com TODAS as peças da OS
    const itens = carregarItens(os.id);
    const total = r2(itens.reduce((t, it) => t + it.subtotal, 0));
    const pago = r2(db().prepare('SELECT COALESCE(SUM(valor), 0) AS t FROM pagamentos WHERE os_id = ?').get(os.id).t);
    const saldo = r2(Math.max(total - pago, 0));
    db().prepare('UPDATE ordens SET valor_total = ?, sinal = ?, saldo = ?, data_entrega = ? WHERE id = ?')
      .run(total, pago, saldo, dados.data_entrega || os.data_entrega, os.id);

    const osStatus = sincronizarStatusOS(os.id);
    return { success: true, total, pago, saldo, osStatus };
  })();
});

ipcMain.handle('registrar-pagamento', (event, { os_id, valor, forma_pagamento }) => {
  const v = Number(valor);
  if (!(v > 0)) throw new Error('Valor inválido');

  const tx = db().transaction(() => {
    db().prepare('INSERT INTO pagamentos (os_id, valor, forma_pagamento) VALUES (?, ?, ?)')
      .run(os_id, v, forma_pagamento || 'Pix');

    const os = db().prepare('SELECT valor_total FROM ordens WHERE id = ?').get(os_id);
    const pago = db().prepare('SELECT COALESCE(SUM(valor), 0) AS total FROM pagamentos WHERE os_id = ?').get(os_id).total;
    const saldo = Math.max((os.valor_total || 0) - pago, 0);
    db().prepare('UPDATE ordens SET sinal = ?, saldo = ? WHERE id = ?').run(pago, saldo, os_id);
    return { success: true, pago, saldo };
  });

  return tx();
});

// ----- Logo (data URL, para entrar na imagem da OS) -----
let logoCache = null;
ipcMain.handle('get-logo', () => {
  if (!logoCache) {
    const png = fs.readFileSync(path.join(__dirname, 'src', 'logo.png'));
    logoCache = 'data:image/png;base64,' + png.toString('base64');
  }
  return logoCache;
});

// ==========================================
// RELATÓRIOS
// ==========================================
const DT_ENTRADA = "COALESCE(o.data_entrada, substr(o.criado, 1, 10))";

// Peças a produzir (OS com status Aguardando / Em Produção)
//   modo 'dia'  = entrega marcada exatamente para a data
//   modo 'ate'  = entrega até a data (inclui atrasadas)
//   modo 'todas'= todas as pendentes
ipcMain.handle('relatorio-producao', (event, { data, modo, empresa, incluirProntas } = {}) => {
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(data || '') ? data : hojeLocal();
  const filtros = ["o.status IN ('Aguardando', 'Em Produção')"];
  const params = [];
  if (modo === 'dia') { filtros.push('o.data_entrega = ?'); params.push(dia); }
  else if (modo === 'todas') { /* sem filtro de data */ }
  else { filtros.push('o.data_entrega <= ?'); params.push(dia); }

  const ordens = db().prepare(
    `SELECT o.* FROM ordens o WHERE ${filtros.join(' AND ')} ORDER BY o.data_entrega ASC, o.id ASC`
  ).all(...params);

  const porEmpresa = Object.fromEntries(EMPRESAS.map((e) => [e, 0]));
  let totalPecas = 0;
  const saida = [];
  for (const o of ordens) {
    let itens = carregarItens(o.id); // a numeração (Peça #1, #2...) é a da OS inteira
    if (EMPRESAS.includes(empresa)) itens = itens.filter((it) => it.empresa === empresa);
    if (!incluirProntas) itens = itens.filter((it) => it.status !== 'Pronta'); // o que já foi feito não precisa produzir de novo
    if (!itens.length) continue;
    for (const it of itens) {
      totalPecas += it.qtd || 1;
      porEmpresa[it.empresa] = (porEmpresa[it.empresa] || 0) + (it.qtd || 1);
    }
    saida.push({ ...o, itens });
  }
  return { data: dia, modo: modo || 'ate', empresa: empresa || '', incluirProntas: !!incluirProntas, hoje: hojeLocal(), ordens: saida, totalOS: saida.length, totalPecas, porEmpresa };
});

ipcMain.handle('relatorio-clientes', (event, { ordenar } = {}) => {
  const ordem = {
    gasto: 'totalGasto DESC, c.nome COLLATE NOCASE ASC',
    recente: "(ultima IS NULL) ASC, ultima DESC, c.nome COLLATE NOCASE ASC",
    nome: 'c.nome COLLATE NOCASE ASC'
  }[ordenar] || 'c.nome COLLATE NOCASE ASC';

  const clientes = db().prepare(`
    SELECT c.id, c.nome, c.tel, c.cidade, c.endereco, c.cadastro,
           COUNT(o.id) AS qtdOS,
           COALESCE(SUM(o.valor_total), 0) AS totalGasto,
           MAX(${DT_ENTRADA}) AS ultima
      FROM clientes c
      LEFT JOIN ordens o ON o.cliente_id = c.id AND o.status != 'Cancelado'
     GROUP BY c.id
     ORDER BY ${ordem}
  `).all();

  return {
    hoje: hojeLocal(),
    ordenar: ordenar || 'nome',
    clientes,
    totais: {
      clientes: clientes.length,
      os: clientes.reduce((t, c) => t + c.qtdOS, 0),
      gasto: r2(clientes.reduce((t, c) => t + c.totalGasto, 0))
    }
  };
});

// Quanto UM cliente gastou (opcionalmente num período, pela data de entrada da OS)
ipcMain.handle('relatorio-cliente', (event, { cliente_id, de, ate } = {}) => {
  const cliente = db().prepare('SELECT * FROM clientes WHERE id = ?').get(cliente_id);
  if (!cliente) throw new Error('Cliente não encontrado.');

  const filtros = ['o.cliente_id = ?'];
  const params = [cliente_id];
  const dataOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  if (dataOk(de)) { filtros.push(`${DT_ENTRADA} >= ?`); params.push(de); }
  if (dataOk(ate)) { filtros.push(`${DT_ENTRADA} <= ?`); params.push(ate); }

  const ordens = db().prepare(
    `SELECT o.*, ${DT_ENTRADA} AS data_ref FROM ordens o WHERE ${filtros.join(' AND ')} ORDER BY data_ref DESC, o.id DESC`
  ).all(...params);

  const pagoStmt = db().prepare('SELECT COALESCE(SUM(valor), 0) AS t FROM pagamentos WHERE os_id = ?');
  const porEmpresa = Object.fromEntries(EMPRESAS.map((e) => [e, 0]));
  let total = 0, pago = 0, aberto = 0, qtd = 0;

  for (const o of ordens) {
    o.itens = carregarItens(o.id);
    o.pago = r2(pagoStmt.get(o.id).t);
    if (o.status === 'Cancelado') continue; // OS cancelada aparece na lista, mas não entra nos totais
    qtd++;
    total += o.valor_total || 0;
    pago += o.pago;
    aberto += o.saldo || 0;
    for (const it of o.itens) porEmpresa[it.empresa] = r2((porEmpresa[it.empresa] || 0) + it.subtotal);
  }

  return {
    hoje: hojeLocal(), cliente, de: dataOk(de) ? de : '', ate: dataOk(ate) ? ate : '', ordens,
    resumo: { qtd, total: r2(total), pago: r2(pago), aberto: r2(aberto), ticket: qtd ? r2(total / qtd) : 0 },
    porEmpresa
  };
});

// Salva a tela atual (já com o estilo de impressão do relatório) como PDF
ipcMain.handle('salvar-relatorio-pdf', async (event, nomeSugerido) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar relatório em PDF',
    defaultPath: (nomeSugerido || 'relatorio') + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { ok: false, cancelado: true };
  const pdf = await mainWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  fs.writeFileSync(filePath, pdf);
  return { ok: true, caminho: filePath };
});

// ----- Exportação / Compartilhamento -----
ipcMain.handle('save-image-dialog', async (event, base64Data, nomeSugerido) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar OS como Imagem',
    defaultPath: (nomeSugerido || 'Ordem_de_Servico') + '.png',
    filters: [{ name: 'Imagens', extensions: ['png'] }]
  });

  if (filePath) {
    const buffer = Buffer.from(base64Data.replace(/^data:image\/png;base64,/, ''), 'base64');
    fs.writeFileSync(filePath, buffer);
    return true;
  }
  return false;
});

// Copia a imagem para a área de transferência (para colar na conversa do WhatsApp com Ctrl+V).
// Electron 44+ removeu clipboard.writeImage: usa clipboard.write() com ClipboardItem.
// Electron 43 ou anterior: usa a função antiga (mantida só por compatibilidade).
ipcMain.handle('copiar-imagem', async (event, dataUrl) => {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Imagem inválida');
  const png = Buffer.from(m[1], 'base64');

  if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  } else if (typeof clipboard.writeImage === 'function') {
    clipboard.writeImage(nativeImage.createFromBuffer(png));
  } else {
    throw new Error('Esta versão do Electron não permite copiar imagens.');
  }
  return true;
});

ipcMain.handle('abrir-whatsapp', async (event, { tel }) => {
  let digitos = String(tel || '').replace(/\D/g, '');
  if (digitos.length === 10 || digitos.length === 11) digitos = '55' + digitos; // DDD + número (Brasil)
  await shell.openExternal(digitos ? `https://wa.me/${digitos}` : 'https://wa.me/');
  return true;
});

// ==========================================
// BACKUP / RESTAURAÇÃO
// ==========================================
const infoPath = () => path.join(app.getPath('userData'), 'backup-info.json');

function lerInfoBackup() {
  try { return JSON.parse(fs.readFileSync(infoPath(), 'utf8')); } catch { return null; }
}

ipcMain.handle('get-backup-info', () => lerInfoBackup());

ipcMain.handle('fazer-backup', async () => {
  const nomeArquivo = `backup_sos_roupas_${stampLocal()}.db`;
  const ultimo = lerInfoBackup();
  let pasta = null;
  if (ultimo && ultimo.caminho) {
    const d = path.dirname(ultimo.caminho);
    if (fs.existsSync(d)) pasta = d; // pendrive do último backup, se estiver conectado
  }
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar backup (escolha o pendrive)',
    defaultPath: pasta ? path.join(pasta, nomeArquivo) : nomeArquivo,
    filters: [{ name: 'Backup SOS Roupas', extensions: ['db'] }]
  });
  if (canceled || !filePath) return { ok: false, cancelado: true };

  const dbAtual = path.join(app.getPath('userData'), 'sos_roupas.db');
  if (path.resolve(filePath) === path.resolve(dbAtual)) {
    return { ok: false, erro: 'Escolha outro local: esse é o arquivo do próprio sistema.' };
  }

  // db.backup() é seguro com o banco em uso e já inclui os dados pendentes do modo WAL
  await db().backup(filePath);

  // Deixa o backup como UM único arquivo (sem -wal/-shm) e confere a integridade
  const b = new Database(filePath);
  try {
    b.pragma('journal_mode = DELETE');
    const check = b.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error('O arquivo de backup falhou na verificação: ' + check);
  } finally {
    b.close();
  }

  const info = { ultimo: new Date().toISOString(), caminho: filePath };
  fs.writeFileSync(infoPath(), JSON.stringify(info));
  return { ok: true, caminho: filePath, tamanho: fs.statSync(filePath).size, ...info };
});

// Caminho do backup escolhido e VALIDADO aqui no processo principal (a tela não consegue indicar outro arquivo)
let restauracaoPendente = null;

ipcMain.handle('escolher-backup-restaurar', async () => {
  restauracaoPendente = null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolha o arquivo de backup',
    properties: ['openFile'],
    filters: [{ name: 'Backup SOS Roupas', extensions: ['db'] }]
  });
  if (canceled || !filePaths || !filePaths[0]) return { cancelado: true };

  const caminho = filePaths[0];
  let b;
  try {
    b = new Database(caminho, { readonly: true, fileMustExist: true });
    const tabelas = b.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    for (const t of ['clientes', 'ordens', 'os_itens', 'pagamentos']) {
      if (!tabelas.includes(t)) return { erro: 'Este arquivo não é um backup do SOS Roupas.' };
    }
    restauracaoPendente = caminho;
    return {
      nomeArquivo: path.basename(caminho),
      clientes: b.prepare('SELECT COUNT(*) AS n FROM clientes').get().n,
      ordens: b.prepare('SELECT COUNT(*) AS n FROM ordens').get().n
    };
  } catch (e) {
    return { erro: 'Não foi possível ler esse arquivo: ' + e.message };
  } finally {
    if (b) b.close();
  }
});

ipcMain.handle('confirmar-restauracao', async () => {
  const caminho = restauracaoPendente;
  restauracaoPendente = null;
  if (!caminho || !fs.existsSync(caminho)) throw new Error('Nenhum backup selecionado. Escolha o arquivo novamente.');
  const userData = app.getPath('userData');
  const dbAtual = path.join(userData, 'sos_roupas.db');

  // Cópia de segurança dos dados atuais, caso a pessoa se arrependa
  const pastaSeg = path.join(userData, 'backups-automaticos');
  fs.mkdirSync(pastaSeg, { recursive: true });
  await db().backup(path.join(pastaSeg, `antes_de_restaurar_${stampLocal()}.db`));

  db().close();
  database.db = null;
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbAtual + ext); } catch { /* não existe */ }
  }
  fs.copyFileSync(caminho, dbAtual);

  app.relaunch();
  app.exit(0);
  return true;
});
