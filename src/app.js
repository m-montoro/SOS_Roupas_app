const { ipcRenderer } = require('electron');
const htmlToImage = require('html-to-image');

// ESTADO LOCAL 
let clientes = [];
let ordens = [];
let pecaSeq = 0; // contador usado só para gerar ids únicos dos blocos de peça

const STATUS_LIST = ['Aguardando', 'Em Produção', 'Pronto', 'Entregue', 'Cancelado'];
const EMPRESAS = ['SOS Roupas', "Bruan's...", 'MB Fitness'];
const STATUS_PECA = ['A fazer', 'Em Produção', 'Pronta'];
const slug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

// MAPA DE SERVIÇOS
const servicosMap = {
  'Conserto de Roupa': ['Ajuste de bainha', 'Ajuste de cós', 'Troca de zíper', 'Costura de rasgado', 'Colocar botão', 'Franzir / Elástico', 'Ajuste de manga', 'Reforma completa'],
  'Confecção de Biquíni': ['Biquíni top cortininha', 'Biquíni top triangular', 'Biquíni top nadador', 'Calcinha fio dental', 'Calcinha hot pants', 'Conjunto completo', 'Sob encomenda'],
  'Ajuste / Adaptação': ['Reduzir tamanho', 'Aumentar tamanho', 'Ajuste no busto', 'Ajuste no quadril', 'Encurtar peça', 'Alongar peça'],
  'Customização': ['Bordado personalizado', 'Aplicação de pedrarias', 'Corte e recorte', 'Tie dye', 'Pintura em tecido', 'Franja / Detalhes'],
  'Bordado / Aplicação': ['Bordado à mão', 'Bordado à máquina', 'Aplicação de patches', 'Monograma', 'Aplique floral'],
  'Outros': ['Serviço personalizado']
};

// UTILITÁRIOS 
const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function brl(n) {
  return (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtData(iso) {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : esc(iso);
}

function hojeLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toast(msg, tipo = 'ok', ms = 3200) {
  const box = $('toast-container');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (tipo === 'erro' ? 'toast-erro' : 'toast-ok');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('toast-hide'), ms);
  setTimeout(() => el.remove(), ms + 500);
}

function erroGenerico(contexto, err) {
  console.error(contexto, err);
  toast(`${contexto}: ${err && err.message ? err.message : err}`, 'erro');
}

// MODAL (substitui alert/confirm/prompt, que travam o foco dos campos no Electron) 
let modalResolver = null;

function abrirModal(html) {
  $('modal-box').innerHTML = html;
  $('modal-overlay').classList.add('open');
}

function fecharModal(resultado) {
  $('modal-overlay').classList.remove('open');
  $('modal-box').innerHTML = '';
  if (modalResolver) {
    const r = modalResolver;
    modalResolver = null;
    r(resultado);
  }
}

function confirmar(mensagem, textoOk = 'Confirmar') {
  return new Promise((resolve) => {
    modalResolver = resolve;
    abrirModal(`
      <div class="modal-title">Confirmação</div>
      <p class="modal-text">${esc(mensagem)}</p>
      <div class="form-actions">
        <button class="btn btn-secondary" onclick="fecharModal(false)">Cancelar</button>
        <button class="btn btn-danger" onclick="fecharModal(true)">${esc(textoOk)}</button>
      </div>
    `);
  });
}

function pedirPagamento(os) {
  return new Promise((resolve) => {
    modalResolver = resolve;
    abrirModal(`
      <div class="modal-title">💵 Receber pagamento — ${esc(os.numero)}</div>
      <p class="modal-text">Cliente: <strong>${esc(os.cliente_nome)}</strong><br>Saldo em aberto: <strong>${brl(os.saldo)}</strong></p>
      <div class="form-grid form-grid-2" style="margin-bottom:1rem;">
        <div class="form-group">
          <label>Valor recebido (R$)</label>
          <input type="number" id="pg-valor" min="0.01" step="0.01" value="${(Number(os.saldo) || 0).toFixed(2)}">
        </div>
        <div class="form-group">
          <label>Forma de pagamento</label>
          <select id="pg-forma">
            <option value="Pix">Pix</option>
            <option value="Dinheiro">Dinheiro</option>
            <option value="Cartão de Débito">Cartão de Débito</option>
            <option value="Cartão de Crédito">Cartão de Crédito</option>
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-secondary" onclick="fecharModal(null)">Cancelar</button>
        <button class="btn btn-primary" onclick="fecharModal({ valor: parseFloat($('pg-valor').value), forma: $('pg-forma').value })">✓ Registrar</button>
      </div>
    `);
    setTimeout(() => { const i = $('pg-valor'); if (i) { i.focus(); i.select(); } }, 50);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modal-overlay').classList.contains('open')) fecharModal(null);
});

//  NAVEGAÇÃO ENTRE ABAS 
let secaoAtual = 'dashboard';
let detalheSujo = false; // a tela de detalhes da OS tem alterações ainda não salvas

async function showSection(id) {
  // não perde uma edição sem avisar
  if (secaoAtual === 'os' && id !== 'os' && detalheSujo) {
    const ok = await confirmar('Esta OS tem alterações que ainda não foram salvas. Sair e descartar essas alterações?', 'Descartar');
    if (!ok) return;
    detalheSujo = false;
  }
  secaoAtual = id;

  document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));

  const sec = $('section-' + id);
  const tab = $('tab-' + (id === 'os' ? 'ordens' : id)); // a tela da OS fica sob a aba "Ordens"
  if (sec) sec.classList.add('active');
  if (tab) tab.classList.add('active');
  window.scrollTo(0, 0);

  if (id === 'dashboard') updateDashboard();
  if (id === 'clientes') renderClientes();
  if (id === 'ordens') renderOrdens();
  if (id === 'nova-os') iniciarNovaOS();
  if (id === 'relatorios') abrirRelatorio(relAtual);
}

// RELÓGIO 
function updateDateTime() {
  const now = new Date();
  const opts = { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' };
  const d = now.toLocaleDateString('pt-BR', opts);
  const t = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const el = $('datetime-display');
  if (el) el.textContent = d + ' · ' + t;
}
setInterval(() => {
  updateDateTime();
  // Se o usuário não escolheu outro mês, acompanha o mês atual (vira sozinho à meia-noite do dia 1º)
  const dash = $('section-dashboard');
  if (mesAuto && dash && dash.classList.contains('active') && mesSel !== mesAtualStr()) updateDashboard();
}, 1000);

// DASHBOARD 
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const pad2 = (n) => String(n).padStart(2, '0');

let mesSel = null;   // mês exibido, 'YYYY-MM'
let mesAuto = true;  // true = acompanha o mês atual automaticamente

function mesAtualStr() { return hojeLocal().slice(0, 7); }

// Soma meses com virada de ano correta: dez/2026 + 1 = jan/2027 e jan/2027 - 1 = dez/2026
function somarMeses(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

function mudarMes(delta) {
  mesSel = somarMeses(mesSel || mesAtualStr(), delta);
  mesAuto = mesSel === mesAtualStr();
  updateDashboard();
}

function escolherMesAno() {
  mesSel = `${$('sel-ano').value}-${$('sel-mes').value}`;
  mesAuto = mesSel === mesAtualStr();
  updateDashboard();
}

function irParaMesAtual() {
  mesSel = mesAtualStr();
  mesAuto = true;
  updateDashboard();
}

function montarSeletorMes(mes, anoMin) {
  const [ano, mm] = mes.split('-').map(Number);
  const anoMax = Math.max(ano, Number(hojeLocal().slice(0, 4)));
  $('sel-mes').innerHTML = MESES.map((n, i) => `<option value="${pad2(i + 1)}"${i + 1 === mm ? ' selected' : ''}>${n}</option>`).join('');
  let anos = '';
  for (let y = Math.min(anoMin, ano); y <= anoMax; y++) anos += `<option value="${y}"${y === ano ? ' selected' : ''}>${y}</option>`;
  $('sel-ano').innerHTML = anos;
}

function rotuloMes(ym, curto) {
  const [y, m] = ym.split('-').map(Number);
  return curto ? `${MESES[m - 1].slice(0, 3)}/${String(y).slice(2)}` : `${MESES[m - 1]} de ${y}`;
}

function graficoColunas(el, itens, { destaque = -1, rotuloACada = 1 } = {}) {
  const max = Math.max(0, ...itens.map((i) => i.valor));
  if (max === 0) { el.innerHTML = '<div class="chart-vazio">Sem recebimentos neste período</div>'; return; }
  el.innerHTML = `<div class="cols" style="grid-template-columns:repeat(${itens.length},1fr)">` +
    itens.map((i, idx) => `
      <div class="col${idx === destaque ? ' col-destaque' : ''}" title="${esc(i.titulo)}">
        <div class="col-area"><div class="col-bar" style="height:${i.valor > 0 ? Math.max((i.valor / max) * 100, 1.5).toFixed(1) : 0}%"></div></div>
        <div class="col-lbl">${idx % rotuloACada === 0 ? esc(i.rotulo) : ''}</div>
      </div>`).join('') + '</div>';
}

function graficoBarrasH(el, itens, vazio) {
  const max = Math.max(0, ...itens.map((i) => i.valor));
  if (!itens.length || max === 0) { el.innerHTML = `<div class="chart-vazio">${esc(vazio)}</div>`; return; }
  el.innerHTML = itens.map((i) => `
    <div class="hrow">
      <div class="hrow-lbl" title="${esc(i.rotulo)}">${esc(i.rotulo)}</div>
      <div class="hrow-track"><div class="hrow-bar" style="width:${((i.valor / max) * 100).toFixed(1)}%"></div></div>
      <div class="hrow-val">${esc(i.texto)}</div>
    </div>`).join('');
}

async function updateDashboard() {
  if (mesAuto || !mesSel) mesSel = mesAtualStr();
  try {
    const d = await ipcRenderer.invoke('get-dashboard-stats', mesSel);

    // situação atual
    $('stat-clientes').textContent = d.totalClientes || 0;
    $('stat-aguardando').textContent = d.abertas || 0;
    $('stat-producao').textContent = d.producao || 0;
    $('stat-prontas').textContent = d.prontas || 0;
    $('stat-atrasadas').textContent = d.atrasadas || 0;
    $('stat-areceber').textContent = brl(d.aReceber);

    // mês selecionado
    $('mes-titulo').textContent = rotuloMes(d.mes);
    montarSeletorMes(d.mes, d.anoMin);
    $('stat-faturamento').textContent = brl(d.faturamento);
    $('stat-os-mes').textContent = d.osMes || 0;
    $('stat-entregas-mes').textContent = d.entregasMes || 0;
    $('stat-ticket').textContent = brl(d.ticketMedio);
    $('stat-novos-clientes').textContent = d.novosClientes || 0;

    // gráficos
    graficoColunas($('chart-dias'), d.porDia.map((x) => ({
      valor: x.total, rotulo: String(x.dia), titulo: `Dia ${x.dia}: ${brl(x.total)}`
    })), { rotuloACada: d.porDia.length > 20 ? 2 : 1 });

    graficoColunas($('chart-12m'), d.ultimos12.map((x) => ({
      valor: x.total, rotulo: rotuloMes(x.mes, true), titulo: `${rotuloMes(x.mes)}: ${brl(x.total)}`
    })), { destaque: 11 });

    graficoBarrasH($('chart-formas'), d.formas.map((f) => ({ rotulo: f.forma, valor: f.total, texto: brl(f.total) })), 'Sem pagamentos neste mês');
    graficoBarrasH($('chart-servicos'), d.servicos.map((x) => ({ rotulo: x.nome, valor: x.qtd, texto: `${x.qtd} peça${x.qtd > 1 ? 's' : ''}` })), 'Sem ordens neste mês');
    graficoBarrasH($('chart-status'), d.statusMes.map((x) => ({ rotulo: x.status, valor: x.qtd, texto: String(x.qtd) })), 'Sem ordens neste mês');
  } catch (err) {
    erroGenerico('Erro ao carregar o dashboard', err);
  }
  atualizarInfoBackup();
}

// BACKUP 
async function atualizarInfoBackup() {
  const el = $('backup-info');
  if (!el) return;
  try {
    const info = await ipcRenderer.invoke('get-backup-info');
    if (!info) {
      el.textContent = '⚠ Nenhum backup feito ainda';
      el.classList.add('alerta');
      return;
    }
    const dt = new Date(info.ultimo);
    const dias = Math.floor((Date.now() - dt.getTime()) / 86400000);
    el.textContent = `Último backup: ${dt.toLocaleDateString('pt-BR')} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` +
      (dias >= 7 ? ` — ⚠ faz ${dias} dias` : '');
    el.classList.toggle('alerta', dias >= 7);
  } catch (err) {
    console.error(err);
  }
}

async function fazerBackup() {
  try {
    const r = await ipcRenderer.invoke('fazer-backup');
    if (r.cancelado) return;
    if (!r.ok) { toast(r.erro || 'Não foi possível fazer o backup.', 'erro'); return; }
    toast(`Backup salvo com sucesso! (${(r.tamanho / 1024).toFixed(0)} KB)`, 'ok', 5000);
    atualizarInfoBackup();
  } catch (err) {
    erroGenerico('Erro ao fazer backup', err);
  }
}

async function restaurarBackup() {
  try {
    const r = await ipcRenderer.invoke('escolher-backup-restaurar');
    if (!r || r.cancelado) return;
    if (r.erro) { toast(r.erro, 'erro', 5000); return; }
    const ok = await confirmar(
      `Restaurar o backup "${r.nomeArquivo}" (${r.clientes} clientes e ${r.ordens} ordens)? ` +
      `Os dados atuais serão SUBSTITUÍDOS (uma cópia de segurança deles é guardada automaticamente) e o sistema vai reiniciar.`,
      'Restaurar'
    );
    if (!ok) return;
    await ipcRenderer.invoke('confirmar-restauracao');
  } catch (err) {
    erroGenerico('Erro ao restaurar backup', err);
  }
}

// CLIENTES 
async function salvarCliente() {
  const nome = $('cli-nome').value.trim();
  const tel = $('cli-tel').value.trim();
  if (!nome || !tel) { toast('Preencha Nome e Telefone!', 'erro'); return; }

  const cli = {
    id: $('cliente-id').value || null,
    nome,
    tel,
    endereco: $('cli-endereco').value.trim(),
    cidade: $('cli-cidade').value.trim(),
    obs: $('cli-obs').value.trim(),
    medidas: $('cli-medidas').value.trim()
  };

  try {
    await ipcRenderer.invoke('salvar-cliente', cli);
    toast(cli.id ? 'Cliente atualizado!' : 'Cliente cadastrado!');
    limparFormCliente();
    await renderClientes();
  } catch (err) {
    erroGenerico('Erro ao salvar cliente', err);
  }
}

function limparFormCliente() {
  ['cli-nome', 'cli-tel', 'cli-endereco', 'cli-cidade', 'cli-obs', 'cli-medidas', 'cliente-id'].forEach((id) => {
    const el = $(id);
    if (el) el.value = '';
  });
  $('cliente-form-titulo').textContent = '👤 Novo Cliente';
  $('btn-cancelar-edicao').style.display = 'none';
}

function cancelarEdicaoCliente() {
  limparFormCliente();
}

function editarCliente(id) {
  const c = clientes.find((x) => x.id === id);
  if (!c) return;
  $('cliente-id').value = c.id;
  $('cli-nome').value = c.nome || '';
  $('cli-tel').value = c.tel || '';
  $('cli-endereco').value = c.endereco || '';
  $('cli-cidade').value = c.cidade || '';
  $('cli-obs').value = c.obs || '';
  $('cli-medidas').value = c.medidas || '';
  $('cliente-form-titulo').textContent = '✏️ Editar Cliente';
  $('btn-cancelar-edicao').style.display = 'inline-flex';
  window.scrollTo(0, 0);
  $('cli-nome').focus();
}

async function renderClientes() {
  const tbody = $('clientes-tbody');
  if (!tbody) return;
  try {
    clientes = await ipcRenderer.invoke('get-clientes');
  } catch (err) {
    erroGenerico('Erro ao carregar clientes', err);
    return;
  }

  if (!clientes.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="td-vazio">Nenhum cliente cadastrado</td></tr>`;
    return;
  }

  tbody.innerHTML = clientes.map((c, i) => `
    <tr>
      <td><strong>${String(i + 1).padStart(3, '0')}</strong></td>
      <td><strong>${esc(c.nome)}</strong></td>
      <td>${esc(c.tel)}</td>
      <td>${esc(c.cidade) || '—'}</td>
      <td class="td-acoes">
        <button class="btn btn-sm btn-secondary" onclick="editarCliente(${c.id})">✏️ Editar</button>
        <button class="btn btn-sm btn-danger" onclick="deletarCliente(${c.id})">🗑 Excluir</button>
      </td>
    </tr>
  `).join('');
}

async function deletarCliente(id) {
  const c = clientes.find((x) => x.id === id);
  const ok = await confirmar(`Deseja excluir o cliente "${c ? c.nome : ''}"? As ordens de serviço dele continuam salvas no histórico.`, 'Excluir');
  if (!ok) return;
  try {
    await ipcRenderer.invoke('deletar-cliente', id);
    if ($('cliente-id').value == id) limparFormCliente();
    toast('Cliente excluído.');
    await renderClientes();
  } catch (err) {
    erroGenerico('Erro ao excluir cliente', err);
  }
}

// BLOCOS DE PEÇAS (usados na Nova OS e na tela de detalhes da OS)
function htmlAdicional(descricao, valor) {
  return `
    <div class="adic-row">
      <input type="text" class="adic-desc" placeholder="Ex: Fazer a bainha 2,5cm" value="${esc(descricao)}" oninput="pecaMudou(this)">
      <input type="number" class="adic-valor" step="0.01" min="0" placeholder="a definir" value="${Number(valor) > 0 ? Number(valor).toFixed(2) : ''}" title="Valor (R$)" oninput="pecaMudou(this)">
      <button class="btn btn-danger btn-sm" title="Remover" onclick="removerAdicional(this)">✕</button>
    </div>`;
}

function opcoesServico(tipo, atual) {
  const lista = (servicosMap[tipo] || []).slice();
  if (atual && !lista.includes(atual)) lista.push(atual); // mantém um serviço antigo que não está mais na lista
  const vazio = tipo || atual ? '— Selecione —' : '— Selecione o tipo —';
  return `<option value="">${vazio}</option>` +
    lista.map((x) => `<option value="${esc(x)}"${x === atual ? ' selected' : ''}>${esc(x)}</option>`).join('');
}

// Cria um bloco de peça. edicao=true: tela de detalhes (com situação da peça e sem botão remover)
function criarBlocoPeca(container, d = {}, edicao = false) {
  pecaSeq++;
  const v = { tipo: '', servico: '', peca: '', cor: '', qtd: 1, valor: 0, empresa: EMPRESAS[0], obs: '', adicionais: [], status: 'A fazer', ...d };
  const tipos = Object.keys(servicosMap);
  if (v.tipo && !tipos.includes(v.tipo)) tipos.push(v.tipo);

  const div = document.createElement('div');
  div.className = 'peca-block' + (edicao ? ` peca-edicao st-${slug(v.status)}` : '');
  div.id = `peca-block-${pecaSeq}`;
  if (edicao && d.id) div.dataset.itemId = d.id;

  const cabecalho = edicao
    ? `<strong class="peca-num">PEÇA</strong>
       <label class="peca-status-wrap">Situação
         <select class="peca-status sp-${slug(v.status)}" data-anterior="${esc(v.status)}" onchange="statusPecaMudou(this)">
           ${STATUS_PECA.map((x) => `<option value="${esc(x)}"${x === v.status ? ' selected' : ''}>${esc(x)}</option>`).join('')}
         </select>
       </label>`
    : `<strong class="peca-num">PEÇA</strong>
       <button class="btn btn-danger btn-sm peca-remover" onclick="removerBlocoPeca(${pecaSeq})">✕ Remover</button>`;

  div.innerHTML = `
    <div class="peca-head">${cabecalho}</div>
    <div class="form-grid form-grid-3">
      <div class="form-group">
        <label>Tipo de Serviço</label>
        <select class="peca-tipo" onchange="atualizarServicosPeca(this); pecaMudou(this)">
          <option value="">— Selecione —</option>
          ${tipos.map((t) => `<option value="${esc(t)}"${t === v.tipo ? ' selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Serviço Específico</label>
        <select class="peca-servico" onchange="pecaMudou(this)">${opcoesServico(v.tipo, v.servico)}</select>
      </div>
      <div class="form-group">
        <label>Peça de Roupa</label>
        <input type="text" class="peca-nome" placeholder="Ex: Calça Jeans" value="${esc(v.peca)}" oninput="pecaMudou(this)">
      </div>
    </div>
    <div class="form-grid form-grid-3" style="margin-top:0.8rem; margin-bottom:0;">
      <div class="form-group">
        <label>Cor / Detalhes</label>
        <input type="text" class="peca-cor" placeholder="Ex: Azul Escuro" value="${esc(v.cor)}" oninput="pecaMudou(this)">
      </div>
      <div class="form-group">
        <label>Quantidade</label>
        <input type="number" class="peca-qtd" value="${Number(v.qtd) || 1}" min="1" oninput="pecaMudou(this)">
      </div>
      <div class="form-group">
        <label>Valor Unitário (R$)</label>
        <input type="number" class="peca-valor" step="0.01" min="0" placeholder="a definir" value="${Number(v.valor) > 0 ? Number(v.valor).toFixed(2) : ''}" oninput="pecaMudou(this)">
      </div>
    </div>
    <div class="form-grid form-grid-2 peca-extra" style="margin-bottom:0;">
      <div class="form-group">
        <label>Empresa</label>
        <select class="peca-empresa" onchange="pecaMudou(this)">
          ${EMPRESAS.map((e) => `<option value="${esc(e)}"${e === v.empresa ? ' selected' : ''}>${esc(e)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Observações desta peça</label>
        <textarea class="peca-obs" placeholder="Ex: fazer a bainha 2,5cm e trocar o botão da calça" oninput="pecaMudou(this)">${esc(v.obs)}</textarea>
      </div>
    </div>
    <div class="peca-adicionais">
      <div class="peca-adicionais-titulo">Serviços adicionais (somados uma vez nesta peça)</div>
      <div class="adic-lista">${(v.adicionais || []).map((a) => htmlAdicional(a.descricao, a.valor)).join('')}</div>
      <button class="btn btn-secondary btn-sm" onclick="adicionarServicoAdicional(this)">➕ Serviço adicional</button>
    </div>
    <div class="peca-subtotal">Subtotal da peça: <strong class="peca-subtotal-valor">R$ 0,00</strong></div>
  `;
  container.appendChild(div);
  return div;
}

function adicionarBlocoPeca() {
  const container = $('container-pecas');
  if (!container) return;
  criarBlocoPeca(container, {}, false);
  renumerarPecas(container);
  calcularTotalOS();
}

function adicionarServicoAdicional(btn) {
  const bloco = btn.closest('.peca-block');
  const lista = bloco.querySelector('.adic-lista');
  lista.insertAdjacentHTML('beforeend', htmlAdicional('', 0));
  lista.lastElementChild.querySelector('.adic-desc').focus();
  pecaMudou(btn);
}

function removerAdicional(btn) {
  const root = btn.closest('.pecas-root');
  btn.closest('.adic-row').remove();
  recalcularRoot(root);
}

function renumerarPecas(root) {
  const blocos = root.querySelectorAll('.peca-block');
  blocos.forEach((b, i) => {
    b.querySelector('.peca-num').textContent = `PEÇA #${i + 1}`;
    const rem = b.querySelector('.peca-remover');
    if (rem) rem.style.display = blocos.length > 1 ? '' : 'none'; // não deixa remover a única peça que sobrou
  });
}

function removerBlocoPeca(id) {
  const root = $('container-pecas');
  if (root.querySelectorAll('.peca-block').length <= 1) return;
  const el = $(`peca-block-${id}`);
  if (el) el.remove();
  renumerarPecas(root);
  calcularTotalOS();
}

function atualizarServicosPeca(selectTipo) {
  const bloco = selectTipo.closest('.peca-block');
  bloco.querySelector('.peca-servico').innerHTML = opcoesServico(selectTipo.value, '');
}

// Subtotal de uma peça = qtd × valor unitário + serviços adicionais
function subtotalBloco(b) {
  const qtd = parseFloat(b.querySelector('.peca-qtd').value) || 0;
  const val = parseFloat(b.querySelector('.peca-valor').value) || 0;
  const extras = [...b.querySelectorAll('.adic-valor')].reduce((t, i) => t + (parseFloat(i.value) || 0), 0);
  return qtd * val + extras;
}

// Atualiza o subtotal de cada peça (ou "preço a definir") e devolve o total
function atualizarSubtotais(root) {
  let total = 0, semPreco = 0;
  root.querySelectorAll('.peca-block').forEach((b) => {
    const sub = subtotalBloco(b);
    total += sub;
    const sem = !(sub > 0);
    if (sem) semPreco++;
    b.classList.toggle('sem-preco', sem);
    const el = b.querySelector('.peca-subtotal-valor');
    if (el) el.textContent = sem ? 'preço a definir' : brl(sub);
  });
  return { total: Math.round(total * 100) / 100, semPreco };
}

function recalcularRoot(root) {
  if (root && root.id === 'os-det-pecas') { detalheSujo = true; atualizarResumoDetalhe(); }
  else calcularTotalOS();
}

// chamado por qualquer campo de peça quando muda (Nova OS ou detalhes da OS)
function pecaMudou(el) {
  recalcularRoot(el.closest('.pecas-root'));
}

function calcularTotalOS() {
  const { total, semPreco } = atualizarSubtotais($('container-pecas'));
  const elTotal = $('os-valor-total');
  if (elTotal) elTotal.value = total.toFixed(2);
  const aviso = $('os-aviso-preco');
  if (aviso) aviso.textContent = semPreco
    ? `⚠ ${semPreco} peça(s) com preço a definir. Tudo bem: você poderá informar o preço depois, na tela da OS (aba Ordens → Abrir).`
    : '';
  calcularSaldoOS();
}

function calcularSaldoOS() {
  const total = parseFloat($('os-valor-total').value) || 0;
  const sinal = parseFloat($('os-sinal').value) || 0;
  const el = $('os-saldo-display');
  if (el) el.textContent = brl(Math.max(total - sinal, 0));
}

// Lê os campos de um bloco de peça
function lerBlocoPeca(b) {
  let adicionalSemDescricao = false;
  const adicionais = [...b.querySelectorAll('.adic-row')].map((r) => ({
    descricao: r.querySelector('.adic-desc').value.trim(),
    valor: parseFloat(r.querySelector('.adic-valor').value) || 0
  })).filter((a) => {
    if (!a.descricao && a.valor > 0) adicionalSemDescricao = true; // tem valor mas falta descrever o serviço
    return a.descricao;
  });
  const st = b.querySelector('.peca-status');
  return {
    id: b.dataset.itemId ? Number(b.dataset.itemId) : null,
    tipo: b.querySelector('.peca-tipo').value,
    servico: b.querySelector('.peca-servico').value,
    peca: b.querySelector('.peca-nome').value.trim(),
    cor: b.querySelector('.peca-cor').value.trim(),
    qtd: parseInt(b.querySelector('.peca-qtd').value, 10) || 1,
    valor: parseFloat(b.querySelector('.peca-valor').value) || 0,
    empresa: b.querySelector('.peca-empresa').value,
    obs: b.querySelector('.peca-obs').value.trim(),
    status: st ? st.value : 'A fazer',
    adicionais,
    adicionalSemDescricao
  };
}

// Carrega os clientes (a lista usada pela busca)
async function populateClienteSelect() {
  try {
    clientes = await ipcRenderer.invoke('get-clientes');
  } catch (err) {
    erroGenerico('Erro ao carregar clientes', err);
  }
}

// Busca de cliente (nome ou telefone) 
let buscaLista = [];
let buscaIdx = -1;
const normTxt = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Ignora maiúsculas/acentos ("jose" acha "José"); aceita várias palavras em qualquer ordem; telefone por dígitos
function filtrarClientes(q) {
  const nq = normTxt(q).trim();
  if (!nq) return clientes.slice();
  const palavras = nq.split(/\s+/);
  const digitos = String(q).replace(/\D/g, '');
  const lista = clientes.filter((c) => {
    const nome = normTxt(c.nome);
    if (palavras.every((p) => nome.includes(p))) return true;
    return digitos.length >= 3 && String(c.tel || '').replace(/\D/g, '').includes(digitos);
  });
  // quem COMEÇA com o que foi digitado vem primeiro
  return lista.sort((a, b) => Number(normTxt(b.nome).startsWith(nq)) - Number(normTxt(a.nome).startsWith(nq)));
}

function desenharResultadosCliente() {
  const box = $('os-cliente-resultados');
  const q = $('os-cliente-busca').value;
  const todos = filtrarClientes(q);
  buscaLista = todos.slice(0, 8);
  if (buscaIdx >= buscaLista.length) buscaIdx = buscaLista.length - 1;

  if (!clientes.length) {
    box.innerHTML = '<div class="cli-aviso">Nenhum cliente cadastrado ainda. Preencha o nome e o telefone ao lado para uma OS avulsa.</div>';
  } else if (!buscaLista.length) {
    box.innerHTML = '<div class="cli-aviso">Nenhum cliente encontrado. Para uma OS avulsa, preencha o nome e o telefone ao lado.</div>';
  } else {
    box.innerHTML = buscaLista.map((c, i) => `
      <div class="cli-item${i === buscaIdx ? ' ativo' : ''}" data-id="${c.id}" onmousedown="event.preventDefault(); selecionarClienteOS(${c.id});">
        <strong>${esc(c.nome)}</strong>
        <small>${esc(c.tel)}${c.cidade ? ' · ' + esc(c.cidade) : ''}</small>
      </div>`).join('') +
      (todos.length > buscaLista.length ? `<div class="cli-aviso">+ ${todos.length - buscaLista.length} cliente(s). Continue digitando para filtrar.</div>` : '');
  }
  box.style.display = 'block';
}

function mostrarResultadosCliente() {
  buscaIdx = -1;
  if ($('os-cliente-select').value) return; // já tem cliente escolhido
  desenharResultadosCliente();
}

function esconderResultadosCliente() {
  $('os-cliente-resultados').style.display = 'none';
  buscaIdx = -1;
}

// Digitou na busca: se havia um cliente escolhido, desfaz a escolha e limpa nome/telefone
function buscaClienteDigitou() {
  if ($('os-cliente-select').value) {
    limparClienteOS(false);
  }
  buscaIdx = -1;
  desenharResultadosCliente();
}

function tecladoBuscaCliente(e) {
  const aberto = $('os-cliente-resultados').style.display !== 'none';
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!aberto) desenharResultadosCliente();
    if (!buscaLista.length) return;
    buscaIdx = e.key === 'ArrowDown' ? (buscaIdx + 1) % buscaLista.length : (buscaIdx - 1 + buscaLista.length) % buscaLista.length;
    desenharResultadosCliente();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (buscaIdx >= 0 && buscaLista[buscaIdx]) selecionarClienteOS(buscaLista[buscaIdx].id);
    else if (buscaLista.length === 1) selecionarClienteOS(buscaLista[0].id);
  } else if (e.key === 'Escape') {
    esconderResultadosCliente();
  }
}

function selecionarClienteOS(id) {
  const c = clientes.find((x) => String(x.id) === String(id));
  if (!c) return;
  $('os-cliente-select').value = c.id;
  $('os-cliente-busca').value = c.nome;
  $('os-cliente-nome').value = c.nome;
  $('os-cliente-tel').value = c.tel || '';
  const chip = $('os-cliente-chip');
  chip.innerHTML = `<span>✓ Cliente cadastrado: ${esc(c.nome)} · ${esc(c.tel)}</span><button type="button" onclick="limparClienteOS(true)">✕ Trocar</button>`;
  chip.style.display = 'flex';
  esconderResultadosCliente();
}

function limparClienteOS(focar) {
  $('os-cliente-select').value = '';
  $('os-cliente-busca').value = '';
  $('os-cliente-chip').style.display = 'none';
  $('os-cliente-nome').value = '';
  $('os-cliente-tel').value = '';
  $('os-cliente-chip').style.display = 'none';
  if (focar) {
    $('os-cliente-busca').value = '';
    $('os-cliente-busca').focus();
  }
}

// Mudou o nome na mão: deixa de ser o cliente cadastrado (vira avulso) para não gravar no cliente errado
function nomeOSAlterado() {
  const id = $('os-cliente-select').value;
  if (!id) return;
  const c = clientes.find((x) => String(x.id) === String(id));
  if (!c || c.nome.trim().toLowerCase() !== $('os-cliente-nome').value.trim().toLowerCase()) {
    $('os-cliente-select').value = '';
    $('os-cliente-chip').style.display = 'none';
    $('os-cliente-busca').value = '';
  }
}

function setDefaultDates() {
  const entrega = new Date();
  entrega.setDate(entrega.getDate() + 7);
  const p = (n) => String(n).padStart(2, '0');
  const elData = $('os-data-entrega');
  if (elData && !elData.value) {
    elData.value = `${entrega.getFullYear()}-${p(entrega.getMonth() + 1)}-${p(entrega.getDate())}`;
  }
}

function iniciarNovaOS() {
  populateClienteSelect();
  setDefaultDates();
  if ($('container-pecas').querySelectorAll('.peca-block').length === 0) adicionarBlocoPeca();
  calcularTotalOS();
}

function resetFormOS() {
  $('container-pecas').innerHTML = '';
  $('os-cliente-select').value = '';
  $('os-cliente-busca').value = '';
  $('os-cliente-chip').style.display = 'none';
  $('os-cliente-nome').value = '';
  $('os-cliente-tel').value = '';
  $('os-sinal').value = '0.00';
  $('os-forma-sinal').value = 'Pix';
  $('os-data-entrega').value = '';
}

// SALVAR E RENDERIZAR ORDENS DE SERVIÇO 
async function salvarOS() {
  const clienteNome = $('os-cliente-nome').value.trim();
  const dataEntrega = $('os-data-entrega').value;
  const sinal = parseFloat($('os-sinal').value) || 0;

  if (!clienteNome) { toast('Informe o cliente!', 'erro'); return; }
  if (!dataEntrega) { toast('Informe a data de entrega!', 'erro'); return; }
  if (sinal < 0) { toast('O sinal não pode ser negativo.', 'erro'); return; }

  const pecas = [];
  let erroAdicional = false;
  $('container-pecas').querySelectorAll('.peca-block').forEach((b) => {
    const p = lerBlocoPeca(b);
    if (p.adicionalSemDescricao) erroAdicional = true;
    if (p.tipo || p.servico || p.peca || p.obs || p.adicionais.length) pecas.push(p); // ignora blocos totalmente vazios
  });

  if (erroAdicional) { toast('Há um serviço adicional com valor mas sem descrição.', 'erro'); return; }
  if (!pecas.length) { toast('Adicione ao menos uma peça/serviço.', 'erro'); return; }

  // Total provisório: se alguma peça está "a definir", o sinal pode ser maior que o total conhecido
  const subtotal = (p) => p.qtd * p.valor + p.adicionais.reduce((t, a) => t + a.valor, 0);
  const valorTotal = pecas.reduce((t, p) => t + subtotal(p), 0);
  const semPreco = pecas.some((p) => !(subtotal(p) > 0));
  if (sinal > valorTotal + 0.005 && !semPreco) { toast('O sinal não pode ser maior que o valor total.', 'erro'); return; }

  // Só vincula ao cadastro se o nome digitado ainda for o do cliente selecionado
  const selId = $('os-cliente-select').value;
  const cli = clientes.find((x) => String(x.id) === String(selId));
  const vinculado = cli && cli.nome.trim().toLowerCase() === clienteNome.toLowerCase() ? cli : null;

  const osData = {
    cliente_id: vinculado ? vinculado.id : null,
    cliente_nome: clienteNome,
    // cliente cadastrado: sempre o telefone do cadastro; avulso: o que foi digitado
    cliente_tel: vinculado ? vinculado.tel : $('os-cliente-tel').value.trim(),
    sinal,
    forma_sinal: $('os-forma-sinal').value,
    data_entrega: dataEntrega,
    pecas
  };

  try {
    const r = await ipcRenderer.invoke('salvar-os', osData);
    toast(`${r.numeroOs} criada com sucesso!`);
    resetFormOS();
    limparFiltrosOS(false); // para a OS nova aparecer na lista, mesmo que houvesse filtros ligados
    showSection('ordens');
  } catch (err) {
    erroGenerico('Erro ao criar a OS', err);
  }
}

function badgeClass(status) {
  return 'badge badge-' + slug(status);
}

// Busca e filtros da lista de ordens 
const CAMPOS_FILTRO_OS = ['fo-busca', 'fo-status', 'fo-empresa', 'fo-entrega', 'fo-de', 'fo-ate', 'fo-ordem'];

function limparFiltrosOS(redesenhar = true) {
  CAMPOS_FILTRO_OS.forEach((id) => { const el = $(id); if (el) el.value = id === 'fo-ordem' ? 'recentes' : ''; });
  ['fo-saldo', 'fo-sempreco'].forEach((id) => { const el = $(id); if (el) el.checked = false; });
  if (redesenhar) desenharOrdens();
}

function aplicarFiltrosOS() { desenharOrdens(); }

function filtrarOrdens() {
  const textoBusca = $('fo-busca').value;
  const palavras = normTxt(textoBusca).split(/\s+/).map((w) => w.replace(/^#/, '')).filter(Boolean);
  const status = $('fo-status').value, empresa = $('fo-empresa').value, entrega = $('fo-entrega').value;
  const de = $('fo-de').value, ate = $('fo-ate').value;
  const soSaldo = $('fo-saldo').checked, soSemPreco = $('fo-sempreco').checked;
  const hoje = hojeLocal();
  const em7 = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; })();
  const encerrada = (o) => o.status === 'Entregue' || o.status === 'Cancelado';

  const lista = ordens.filter((o) => {
    if (palavras.length) {
      const blob = normTxt([o.numero, o.cliente_nome, o.cliente_tel, o.texto].join(' ')) + ' ' + String(o.cliente_tel || '').replace(/\D/g, '');
      if (!palavras.every((w) => blob.includes(w))) return false;
    }
    if (status === 'abertas') { if (encerrada(o)) return false; }
    else if (status && o.status !== status) return false;
    if (empresa && !(o.empresas || []).includes(empresa)) return false;
    if (entrega === 'atrasadas' && !(o.data_entrega < hoje && !encerrada(o))) return false;
    if (entrega === 'hoje' && !(o.data_entrega === hoje && !encerrada(o))) return false;
    if (entrega === '7dias' && !(o.data_entrega >= hoje && o.data_entrega <= em7 && !encerrada(o))) return false;
    if (de && !(o.data_entrega >= de)) return false;
    if (ate && !(o.data_entrega <= ate)) return false;
    if (soSaldo && !((o.saldo || 0) > 0 && o.status !== 'Cancelado')) return false;
    if (soSemPreco && !(o.sem_preco > 0)) return false;
    return true;
  });

  const ordem = $('fo-ordem').value;
  if (ordem === 'entrega') lista.sort((a, b) => String(a.data_entrega).localeCompare(String(b.data_entrega)) || a.id - b.id);
  else if (ordem === 'maior') lista.sort((a, b) => (b.valor_total || 0) - (a.valor_total || 0));
  else if (ordem === 'cliente') lista.sort((a, b) => normTxt(a.cliente_nome).localeCompare(normTxt(b.cliente_nome)));
  else lista.sort((a, b) => b.id - a.id);
  return lista;
}

function desenharOrdens() {
  const tbody = $('ordens-tbody');
  if (!tbody) return;
  const contador = $('fo-contador');

  if (!ordens.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="td-vazio">Nenhuma ordem registrada</td></tr>`;
    if (contador) contador.textContent = '';
    return;
  }

  const lista = filtrarOrdens();
  const somaTotal = lista.reduce((t, o) => t + (o.status === 'Cancelado' ? 0 : (o.valor_total || 0)), 0);
  const somaSaldo = lista.reduce((t, o) => t + (o.status === 'Cancelado' ? 0 : (o.saldo || 0)), 0);
  if (contador) contador.innerHTML = `Mostrando <strong>${lista.length}</strong> de ${ordens.length} ordens · Total: ${brl(somaTotal)} · A receber: ${brl(somaSaldo)}`;

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="td-vazio">Nenhuma OS encontrada com esses filtros</td></tr>`;
    return;
  }

  const hoje = hojeLocal();
  tbody.innerHTML = lista.map((o) => {
    const atrasada = o.data_entrega && o.data_entrega < hoje && !['Entregue', 'Cancelado'].includes(o.status);
    const aDefinir = o.sem_preco > 0;
    let saldoHtml;
    if (o.status === 'Cancelado') saldoHtml = '—';
    else if ((o.saldo || 0) > 0) saldoHtml = `<span class="saldo-aberto">${brl(o.saldo)}</span>${aDefinir ? ' <span class="tag-definir">+ a definir</span>' : ''}`;
    else if (aDefinir) saldoHtml = '<span class="tag-definir">a definir</span>';
    else saldoHtml = '<span class="saldo-ok">Quitado</span>';
    const prontas = o.pecas_prontas || 0, total = o.pecas_total || 0;
    return `
    <tr>
      <td><a class="link-os" title="Abrir a OS" onclick="abrirOS(${o.id})"><strong>${esc(o.numero)}</strong></a></td>
      <td>${esc(o.cliente_nome)}</td>
      <td>${brl(o.valor_total)}${aDefinir ? ' <span class="tag-definir" title="Há peça sem preço">preço a definir</span>' : ''}</td>
      <td>${saldoHtml}</td>
      <td${atrasada ? ' class="data-atrasada"' : ''}>${fmtData(o.data_entrega)}${atrasada ? ' ⚠' : ''}</td>
      <td><span class="pecas-prog${total > 0 && prontas === total ? ' ok' : ''}">${total ? `${prontas}/${total} prontas` : '—'}</span></td>
      <td>
        <select class="status-select ${badgeClass(o.status)}" onchange="mudarStatus(${o.id}, this.value)">
          ${STATUS_LIST.map((s) => `<option value="${esc(s)}"${s === o.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </td>
      <td class="td-acoes">
        <button class="btn btn-sm btn-primary" onclick="abrirOS(${o.id})">👁 Abrir</button>
        ${(o.saldo || 0) > 0 && o.status !== 'Cancelado' ? `<button class="btn btn-sm btn-secondary" onclick="receberPagamento(${o.id})">💵 Receber</button>` : ''}
        <button class="btn btn-sm btn-secondary" onclick="exportarOSParaPNG(${o.id})">📷 Imagem</button>
        <button class="btn btn-sm btn-secondary" onclick="enviarWhatsApp(${o.id})">📲 WhatsApp</button>
      </td>
    </tr>`;
  }).join('');
}

async function renderOrdens() {
  if (!$('ordens-tbody')) return;
  try {
    ordens = await ipcRenderer.invoke('get-ordens');
  } catch (err) {
    erroGenerico('Erro ao carregar ordens', err);
    return;
  }
  desenharOrdens();
}

async function mudarStatus(id, status) {
  try {
    await ipcRenderer.invoke('atualizar-status-os', { id, status });
    toast('Status atualizado.');
  } catch (err) {
    erroGenerico('Erro ao atualizar status', err);
  }
  renderOrdens();
}

async function receberPagamento(id) {
  let d;
  try {
    d = await ipcRenderer.invoke('get-os-detalhes', id);
  } catch (err) {
    erroGenerico('Erro ao abrir a OS', err);
    return;
  }
  if (!d) return;
  const os = d.os;
  const r = await pedirPagamento(os);
  if (!r) return;
  if (!(r.valor > 0)) { toast('Informe um valor válido.', 'erro'); return; }
  if (r.valor > (os.saldo || 0) + 0.005) { toast('O valor é maior que o saldo em aberto.', 'erro'); return; }
  try {
    await ipcRenderer.invoke('registrar-pagamento', { os_id: id, valor: r.valor, forma_pagamento: r.forma });
    toast('Pagamento registrado!');
  } catch (err) {
    erroGenerico('Erro ao registrar pagamento', err);
  }
  if (secaoAtual === 'os' && osDetalhe && osDetalhe.os.id === id) renderDetalheOS(await ipcRenderer.invoke('get-os-detalhes', id));
  else renderOrdens();
}

// DETALHES DA OS (ver e editar preços, observações, situação das peças) 
let osDetalhe = null; // { os, itens, pagamentos } da OS aberta

function marcarSujo() { detalheSujo = true; }

async function abrirOS(id) {
  try {
    const d = await ipcRenderer.invoke('get-os-detalhes', id);
    if (!d) { toast('OS não encontrada.', 'erro'); return; }
    renderDetalheOS(d);
    showSection('os');
  } catch (err) {
    erroGenerico('Erro ao abrir a OS', err);
  }
}

function voltarParaOrdens() { return showSection('ordens'); }

function renderDetalheOS(d) {
  osDetalhe = d;
  const { os, itens } = d;
  $('os-det-titulo').textContent = `${os.numero} — ${os.cliente_nome}`;
  $('os-det-info').innerHTML = `
    <div class="det-info">
      <div><div class="rotulo">Cliente</div><div class="valor">${esc(os.cliente_nome)}</div></div>
      <div><div class="rotulo">Telefone</div><div class="valor">${esc(os.cliente_tel) || '—'}</div></div>
      <div><div class="rotulo">Entrada</div><div class="valor">${fmtData(os.data_entrada)}</div></div>
      <div><div class="rotulo">Previsão de entrega</div><input type="date" id="os-det-entrega" value="${esc(os.data_entrega || '')}" oninput="marcarSujo()"></div>
      <div><div class="rotulo">Status da OS</div>
        <select id="os-det-status-os" class="status-select ${badgeClass(os.status)}" onchange="statusOSDetalhe(this.value)">
          ${STATUS_LIST.map((x) => `<option value="${esc(x)}"${x === os.status ? ' selected' : ''}>${esc(x)}</option>`).join('')}
        </select></div>
      <div><div class="rotulo">Peças prontas</div><div class="valor" id="os-det-progresso"></div></div>
    </div>
    <div class="det-acoes">
      <button class="btn btn-sm btn-primary" onclick="detalheAcao('imagem')">📷 Imagem</button>
      <button class="btn btn-sm btn-secondary" onclick="detalheAcao('whatsapp')">📲 WhatsApp</button>
      <button class="btn btn-sm btn-secondary" id="os-det-btn-receber" onclick="detalheAcao('receber')" style="${(os.saldo || 0) > 0 && os.status !== 'Cancelado' ? '' : 'display:none;'}">💵 Receber pagamento</button>
    </div>`;

  const root = $('os-det-pecas');
  root.innerHTML = '';
  if (!itens.length) root.innerHTML = '<div class="rep-vazio">Esta OS não tem peças cadastradas.</div>';
  itens.forEach((it) => criarBlocoPeca(root, it, true));
  renumerarPecas(root);
  detalheSujo = false;
  atualizarResumoDetalhe();
}

function atualizarResumoDetalhe() {
  if (!osDetalhe) return;
  const root = $('os-det-pecas');
  const { total, semPreco } = atualizarSubtotais(root);
  const pago = osDetalhe.pagamentos.reduce((t, p) => t + (p.valor || 0), 0);
  const saldo = Math.max(total - pago, 0);

  const selects = [...root.querySelectorAll('.peca-status')];
  const prontas = selects.filter((x) => x.value === 'Pronta').length;
  const prog = $('os-det-progresso');
  if (prog) prog.textContent = selects.length ? `${prontas} de ${selects.length}` : '—';

  $('os-det-resumo').innerHTML = `
    <div class="form-card-title">💰 VALORES</div>
    <div class="det-totais">
      <div><span>Valor total</span><strong>${brl(total)}</strong></div>
      <div><span>Já pago</span><strong>${brl(pago)}</strong></div>
      <div><span>Saldo a receber</span><strong>${brl(saldo)}</strong></div>
    </div>
    ${semPreco ? `<div class="det-aviso">⚠ ${semPreco} peça(s) com <strong>preço a definir</strong>. Preencha o valor e clique em Salvar alterações.</div>` : ''}
    ${pago > total + 0.005 ? `<div class="det-aviso">O cliente já pagou ${brl(pago - total)} a mais do que o total atual.</div>` : ''}
    ${osDetalhe.pagamentos.length ? `<div class="det-pagos"><strong>Pagamentos registrados</strong>${osDetalhe.pagamentos.map((p) =>
      `<div><span>${fmtData(p.data_pagamento)} — ${esc(p.forma_pagamento)}</span><span>${brl(p.valor)}</span></div>`).join('')}</div>` : ''}`;
}

// aplica a situação em um bloco de peça (select, cores)
function aplicarStatusNoBloco(b, status) {
  const sel = b.querySelector('.peca-status');
  sel.value = status;
  sel.dataset.anterior = status;
  sel.className = `peca-status sp-${slug(status)}`;
  b.classList.remove('st-a-fazer', 'st-em-producao', 'st-pronta');
  b.classList.add('st-' + slug(status));
}

// Situação da peça: salva NA HORA (é o que garante saber o que já foi feito se parar no meio)
async function statusPecaMudou(sel) {
  const b = sel.closest('.peca-block');
  const anterior = sel.dataset.anterior || 'A fazer';
  try {
    const r = await ipcRenderer.invoke('atualizar-status-peca', { item_id: Number(b.dataset.itemId), status: sel.value });
    aplicarStatusNoBloco(b, sel.value);
    osDetalhe.os.status = r.osStatus;
    const st = $('os-det-status-os');
    st.value = r.osStatus;
    st.className = `status-select ${badgeClass(r.osStatus)}`;
    atualizarResumoDetalhe();
    toast(`Peça: ${sel.value}. (${r.pecasProntas} de ${r.pecasTotal} prontas)`);
  } catch (err) {
    sel.value = anterior;
    erroGenerico('Erro ao salvar a situação da peça', err);
  }
}

async function statusOSDetalhe(valor) {
  const sel = $('os-det-status-os');
  try {
    await ipcRenderer.invoke('atualizar-status-os', { id: osDetalhe.os.id, status: valor });
    osDetalhe.os.status = valor;
    sel.className = `status-select ${badgeClass(valor)}`;
    if (valor === 'Pronto' || valor === 'Entregue') {
      $('os-det-pecas').querySelectorAll('.peca-block').forEach((b) => { if (b.querySelector('.peca-status')) aplicarStatusNoBloco(b, 'Pronta'); });
    }
    atualizarResumoDetalhe();
    toast('Status da OS atualizado.');
  } catch (err) {
    sel.value = osDetalhe.os.status;
    erroGenerico('Erro ao atualizar o status', err);
  }
}

async function salvarDetalheOS() {
  if (!osDetalhe) return;
  const blocos = [...$('os-det-pecas').querySelectorAll('.peca-block')];
  const pecas = blocos.map(lerBlocoPeca);
  if (pecas.some((p) => p.adicionalSemDescricao)) { toast('Há um serviço adicional com valor mas sem descrição.', 'erro'); return; }
  const entrega = $('os-det-entrega').value;
  if (!entrega) { toast('Informe a previsão de entrega.', 'erro'); return; }
  const id = osDetalhe.os.id;
  try {
    await ipcRenderer.invoke('atualizar-os', { id, data_entrega: entrega, pecas });
    toast('Alterações salvas!');
    renderDetalheOS(await ipcRenderer.invoke('get-os-detalhes', id));
  } catch (err) {
    erroGenerico('Erro ao salvar a OS', err);
  }
}

async function detalheAcao(acao) {
  if (detalheSujo) { toast('Salve as alterações antes de continuar.', 'erro'); return; }
  const id = osDetalhe.os.id;
  if (acao === 'imagem') return exportarOSParaPNG(id);
  if (acao === 'whatsapp') return enviarWhatsApp(id);
  if (acao === 'receber') return receberPagamento(id);
}

//  COMPROVANTE: IMAGEM (PNG) E WHATSAPP 
const COR_EMPRESA = { 'SOS Roupas': '#FFD600', "Bruan's...": '#F6C6E0', 'MB Fitness': '#BDE0FE' };

let logoDataUrl = null;
async function obterLogo() {
  if (!logoDataUrl) logoDataUrl = await ipcRenderer.invoke('get-logo');
  return logoDataUrl;
}

function montarComprovanteHTML({ os, itens, pagamentos }, logo) {
  const pecas = itens.map((it) => {
    const titulo = [it.peca || 'Peça', it.cor ? `(${it.cor})` : ''].filter(Boolean).join(' ');
    const servico = [it.tipo, it.servico].filter(Boolean).join(' — ');
    const aDefinir = !(it.subtotal > 0);
    const adicionais = (it.adicionais || []).map((a) => `
      <div style="display:flex;justify-content:space-between;font-size:13px;padding-left:10px;">
        <span>+ ${esc(a.descricao)}</span><span>${a.valor > 0 ? brl(a.valor) : 'a definir'}</span>
      </div>`).join('');
    const temExtras = (it.adicionais || []).length > 0;
    const pronta = it.status === 'Pronta';
    const linhaQtd = it.valor > 0
      ? `<span>${it.qtd} × ${brl(it.valor)}</span><span>${brl(it.qtd * it.valor)}</span>`
      : `<span>${it.qtd} × (preço a definir)</span><span></span>`;
    return `
      <div style="border:2px solid #000;padding:8px 10px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="font-size:15px;"><strong>Peça #${it.numero}</strong> — <strong>${esc(titulo)}</strong></div>
          <div style="text-align:right;">
            <div style="background:${COR_EMPRESA[it.empresa] || '#eee'};border:2px solid #000;padding:1px 8px;font-size:12px;font-weight:bold;white-space:nowrap;">${esc(it.empresa)}</div>
            <div style="font-size:12px;margin-top:3px;font-weight:bold;color:${pronta ? '#1a7f37' : '#444'};">${pronta ? '✓ ' : ''}${esc(it.status || 'A fazer')}</div>
          </div>
        </div>
        ${servico ? `<div style="font-size:13px;color:#333;margin-top:2px;">${esc(servico)}</div>` : ''}
        ${it.obs ? `<div style="font-size:13px;margin-top:4px;font-style:italic;white-space:pre-wrap;">Obs: ${esc(it.obs)}</div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:6px;border-top:1px dashed #999;padding-top:4px;">${linhaQtd}</div>
        ${adicionais}
        ${aDefinir
          ? '<div style="font-size:14px;font-weight:bold;margin-top:4px;border-top:1px solid #000;padding-top:3px;color:#8a5a00;">Preço a definir</div>'
          : (temExtras || it.qtd > 1 ? `<div style="display:flex;justify-content:space-between;font-size:14px;font-weight:bold;margin-top:4px;border-top:1px solid #000;padding-top:3px;"><span>Subtotal</span><span>${brl(it.subtotal)}</span></div>` : '')}
      </div>`;
  }).join('');
  const haAdefinir = itens.some((it) => !(it.subtotal > 0));

  const pagos = pagamentos.map((p) =>
    `<div style="display:flex;justify-content:space-between;font-size:13px;"><span>${fmtData(p.data_pagamento)} — ${esc(p.forma_pagamento)}</span><span>${brl(p.valor)}</span></div>`
  ).join('');

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#000;">
      <div style="text-align:center;border-bottom:4px solid #000;padding-bottom:10px;margin-bottom:12px;">
        ${logo ? `<img src="${logo}" alt="S.O.S Roupas" style="width:130px;height:130px;display:block;margin:0 auto;">` : '<div style="font-size:30px;font-weight:900;letter-spacing:3px;">SOS ROUPAS</div>'}
        <div style="font-size:12px;letter-spacing:3px;margin-top:6px;">ORDEM DE SERVIÇO</div>
      </div>

      <div style="display:flex;justify-content:space-between;font-size:15px;margin-bottom:10px;">
        <strong style="font-size:20px;">${esc(os.numero)}</strong>
        <span>${esc(os.status)}</span>
      </div>

      <div style="font-size:14px;line-height:1.6;margin-bottom:12px;">
        <div><strong>Cliente:</strong> ${esc(os.cliente_nome)}</div>
        ${os.cliente_tel ? `<div><strong>Telefone:</strong> ${esc(os.cliente_tel)}</div>` : ''}
        <div><strong>Entrada:</strong> ${fmtData(os.data_entrada)} &nbsp;|&nbsp; <strong>Entrega:</strong> ${fmtData(os.data_entrega)}</div>
      </div>

      ${pecas}

      <div style="margin-top:14px;border-top:3px solid #000;padding-top:10px;font-size:15px;">
        <div style="display:flex;justify-content:space-between;"><span>Valor total</span><strong>${brl(os.valor_total)}</strong></div>
        ${haAdefinir ? '<div style="font-size:12px;color:#8a5a00;margin-top:2px;">* Há peça(s) com preço a definir; o valor total será atualizado.</div>' : ''}
        ${pagos ? `<div style="margin:8px 0;padding:8px;background:#f2f2f2;">${pagos}</div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:18px;margin-top:6px;"><span>Saldo a pagar</span><strong>${brl(os.saldo)}</strong></div>
      </div>

      <div style="text-align:center;font-size:12px;margin-top:16px;color:#444;">Obrigado pela preferência! 💛</div>
    </div>`;
}

// Monta o comprovante fora da tela e devolve { dataUrl, dados } com o PNG pronto
async function gerarImagemOS(id) {
  const dados = await ipcRenderer.invoke('get-os-detalhes', id);
  if (!dados) throw new Error('OS não encontrada.');
  const logo = await obterLogo();

  const node = $('os-preview-export');
  try {
    node.innerHTML = montarComprovanteHTML(dados, logo);
    await Promise.all([...node.querySelectorAll('img')].map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dataUrl = await htmlToImage.toPng(node, {
      pixelRatio: 2,
      backgroundColor: '#ffffff',
      skipFonts: true, // funciona offline; o comprovante usa fonte padrão do sistema
      // o contêiner fica fora da tela; na imagem ele precisa estar na posição normal
      style: { position: 'static', left: '0', top: '0', margin: '0' }
    });
    return { dataUrl, dados };
  } finally {
    node.innerHTML = '';
  }
}

async function exportarOSParaPNG(id) {
  try {
    const { dataUrl, dados } = await gerarImagemOS(id);
    const nome = dados.os.numero.replace(/[^\w\-]+/g, '_');
    const salvo = await ipcRenderer.invoke('save-image-dialog', dataUrl, nome);
    if (salvo) toast('Imagem salva com sucesso!');
  } catch (err) {
    erroGenerico('Erro ao gerar imagem', err);
  }
}

// O WhatsApp não permite anexar arquivo por link: copiamos a imagem e abrimos a conversa; basta colar (Ctrl+V)
async function enviarWhatsApp(id) {
  try {
    const { dataUrl, dados } = await gerarImagemOS(id);
    try {
      await ipcRenderer.invoke('copiar-imagem', dataUrl);
    } catch (err) {
      console.error(err);
      toast('Não consegui copiar a imagem. Use o botão 📷 Imagem para salvar e anexe no WhatsApp.', 'erro', 8000);
      return;
    }
    await ipcRenderer.invoke('abrir-whatsapp', { tel: dados.os.cliente_tel });
    toast('Imagem copiada! Na conversa do WhatsApp, aperte Ctrl+V e envie.', 'ok', 9000);
  } catch (err) {
    erroGenerico('Erro ao preparar o WhatsApp', err);
  }
}

// RELATÓRIOS 
let relAtual = 'producao';

const chipEmpresa = (e) => `<span class="rep-empresa emp-${Math.max(EMPRESAS.indexOf(e), 0)}">${esc(e)}</span>`;

function agoraTexto() {
  const d = new Date();
  return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

function cabecalhoRelatorio(titulo, subtitulo) {
  return `
    <div class="rep-head">
      <img class="rep-logo" src="logo.png" alt="">
      <div>
        <h1>${esc(titulo)}</h1>
        <div class="rep-sub">${esc(subtitulo || '')}</div>
        <div class="rep-sub">Emitido em ${agoraTexto()}</div>
      </div>
    </div>`;
}

async function abrirRelatorio(tipo) {
  relAtual = tipo || 'producao';
  ['producao', 'pendentes', 'clientes', 'cliente'].forEach((t) => {
    $('rel-ctrl-' + t).style.display = t === relAtual ? '' : 'none';
    $('reltab-' + t).className = 'btn btn-sm ' + (t === relAtual ? 'btn-primary' : 'btn-secondary');
  });

  if (!$('rp-data').value) $('rp-data').value = hojeLocal();
  if (!$('rt-empresa').options.length) {
    $('rt-empresa').innerHTML = '<option value="">Todas as empresas</option>' +
      EMPRESAS.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  }
  if (!$('rp-empresa').options.length) {
    $('rp-empresa').innerHTML = '<option value="">Todas as empresas</option>' +
      EMPRESAS.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  }
  if (relAtual === 'cliente') {
    try {
      clientes = await ipcRenderer.invoke('get-clientes');
      const atual = $('r1-cliente').value;
      $('r1-cliente').innerHTML = '<option value="">— Selecione um cliente —</option>' +
        clientes.map((c) => `<option value="${c.id}"${String(c.id) === atual ? ' selected' : ''}>${esc(c.nome)} (${esc(c.tel)})</option>`).join('');
    } catch (err) {
      erroGenerico('Erro ao carregar clientes', err);
    }
  }
  gerarRelatorio();
}

async function gerarRelatorio() {
  const out = $('rel-saida');
  try {
    if (relAtual === 'producao') {
      const r = await ipcRenderer.invoke('relatorio-producao', {
        data: $('rp-data').value, modo: $('rp-modo').value, empresa: $('rp-empresa').value, incluirProntas: $('rp-prontas').checked
      });
      out.innerHTML = htmlRelProducao(r);
    } else if (relAtual === 'pendentes') {
      // sem data: tudo que ainda falta fazer, de qualquer dia
      const r = await ipcRenderer.invoke('relatorio-producao', { modo: 'todas', empresa: $('rt-empresa').value, incluirProntas: false });
      out.innerHTML = htmlRelPendentes(r, $('rt-agrupar').value);
    } else if (relAtual === 'clientes') {
      const r = await ipcRenderer.invoke('relatorio-clientes', { ordenar: $('rc-ordenar').value });
      out.innerHTML = htmlRelClientes(r);
    } else {
      const id = $('r1-cliente').value;
      if (!id) {
        out.innerHTML = cabecalhoRelatorio('Gastos do cliente', '') + '<div class="rep-vazio">Selecione um cliente acima para ver o relatório.</div>';
        return;
      }
      const r = await ipcRenderer.invoke('relatorio-cliente', { cliente_id: Number(id), de: $('r1-de').value, ate: $('r1-ate').value });
      out.innerHTML = htmlRelCliente(r);
    }
  } catch (err) {
    erroGenerico('Erro ao gerar relatório', err);
  }
}

function textoFazer(it) {
  const servico = [it.tipo, it.servico].filter(Boolean).join(' — ');
  const partes = [];
  if (servico) partes.push(`<div>${esc(servico)}</div>`);
  if (it.obs) partes.push(`<div class="rep-obs" style="white-space:pre-wrap;">Obs: ${esc(it.obs)}</div>`);
  (it.adicionais || []).forEach((a) => partes.push(`<div>+ ${esc(a.descricao)}</div>`));
  return partes.length ? partes.join('') : '—';
}

function nomePeca(it) {
  return `<strong>Peça #${it.numero}</strong> ${esc(it.peca || '(sem nome)')}${it.cor ? ` (${esc(it.cor)})` : ''}${it.qtd > 1 ? ` ×${it.qtd}` : ''}`;
}

function htmlRelProducao(r) {
  const modoTxt = {
    ate: `Pendentes até ${fmtData(r.data)} (inclui atrasadas)`,
    dia: `Entrega marcada para ${fmtData(r.data)}`,
    todas: 'Todas as pendentes'
  }[r.modo] || '';
  const sub = `${modoTxt}${r.empresa ? ' · Empresa: ' + r.empresa : ''} · OS Aguardando ou Em Produção${r.incluirProntas ? ' · inclui peças já prontas' : ' · peças já prontas não aparecem'}`;
  let html = cabecalhoRelatorio('Produção do dia', sub);

  if (!r.ordens.length) return html + '<div class="rep-vazio">Nenhuma peça para produzir neste filtro. 🎉</div>';

  html += r.ordens.map((o) => {
    const atrasada = o.data_entrega < r.hoje;
    return `
      <div class="rep-os">
        <div class="rep-os-head">
          <strong>${esc(o.numero)}</strong>
          <span>${esc(o.cliente_nome)}</span>
          <span>Entrega: ${fmtData(o.data_entrega)}</span>
          <span>${esc(o.status)}</span>
          ${atrasada ? '<span class="rep-atraso">ATRASADA</span>' : ''}
        </div>
        <table class="rep-table">
          <thead><tr><th style="width:30%">Peça</th><th>O que precisa fazer</th><th style="width:130px">Empresa</th><th style="width:110px">Situação</th></tr></thead>
          <tbody>${o.itens.map((it) => `
            <tr>
              <td>${nomePeca(it)}</td>
              <td class="rep-fazer">${textoFazer(it)}</td>
              <td>${chipEmpresa(it.empresa)}</td>
              <td><span class="rep-status st-${slug(it.status)}">${esc(it.status)}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }).join('');

  html += `
    <div class="rep-h2">Resumo</div>
    <div class="rep-resumo">
      <div><span>Ordens de serviço</span><strong>${r.totalOS}</strong></div>
      <div><span>${r.incluirProntas ? 'Peças (com as prontas)' : 'Peças a produzir'}</span><strong>${r.totalPecas}</strong></div>
      ${EMPRESAS.map((e) => `<div><span>${esc(e)}</span><strong>${r.porEmpresa[e] || 0}</strong></div>`).join('')}
    </div>`;
  return html;
}

function htmlRelClientes(r) {
  const ord = { nome: 'ordem alfabética', gasto: 'quem mais gastou', recente: 'atendimento mais recente' }[r.ordenar] || '';
  let html = cabecalhoRelatorio('Lista de clientes', `${r.totais.clientes} cliente(s) · ${ord}`);
  if (!r.clientes.length) return html + '<div class="rep-vazio">Nenhum cliente cadastrado.</div>';
  html += `
    <table class="rep-table">
      <thead><tr><th>Cliente</th><th>Telefone</th><th>Cidade</th><th class="num">OS</th><th class="num">Total gasto</th><th>Última OS</th></tr></thead>
      <tbody>${r.clientes.map((c) => `
        <tr>
          <td><strong>${esc(c.nome)}</strong></td>
          <td>${esc(c.tel)}</td>
          <td>${esc(c.cidade) || '—'}</td>
          <td class="num">${c.qtdOS}</td>
          <td class="num">${brl(c.totalGasto)}</td>
          <td>${c.ultima ? fmtData(c.ultima) : '—'}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="3">Total</td><td class="num">${r.totais.os}</td><td class="num">${brl(r.totais.gasto)}</td><td></td></tr></tfoot>
    </table>
    <div class="rep-sub" style="margin-top:6px;">Total gasto = soma das OS não canceladas.</div>`;
  return html;
}

function htmlRelCliente(r) {
  const c = r.cliente;
  const periodo = r.de || r.ate ? `Período: ${r.de ? fmtData(r.de) : 'início'} a ${r.ate ? fmtData(r.ate) : 'hoje'}` : 'Todo o período';
  let html = cabecalhoRelatorio('Gastos do cliente', `${c.nome} · ${periodo}`);

  html += `
    <div class="rep-info">
      <div><strong>Cliente:</strong> ${esc(c.nome)}</div>
      <div><strong>Telefone:</strong> ${esc(c.tel)}</div>
      <div><strong>Cidade:</strong> ${esc(c.cidade) || '—'}</div>
      <div><strong>Endereço:</strong> ${esc(c.endereco) || '—'}</div>
    </div>
    <div class="rep-resumo">
      <div><span>Ordens de serviço</span><strong>${r.resumo.qtd}</strong></div>
      <div><span>Total gasto</span><strong>${brl(r.resumo.total)}</strong></div>
      <div><span>Já pago</span><strong>${brl(r.resumo.pago)}</strong></div>
      <div><span>Em aberto</span><strong>${brl(r.resumo.aberto)}</strong></div>
      <div><span>Média por OS</span><strong>${brl(r.resumo.ticket)}</strong></div>
    </div>`;

  if (!r.ordens.length) return html + '<div class="rep-vazio">Este cliente não tem ordens de serviço neste período.</div>';

  html += `
    <div class="rep-h2">Gasto por empresa</div>
    <table class="rep-table" style="max-width:420px;">
      <tbody>${EMPRESAS.map((e) => `<tr><td>${chipEmpresa(e)}</td><td class="num">${brl(r.porEmpresa[e] || 0)}</td></tr>`).join('')}</tbody>
    </table>
    <div class="rep-h2">Ordens de serviço</div>`;

  html += r.ordens.map((o) => `
    <div class="rep-os">
      <div class="rep-os-head">
        <strong>${esc(o.numero)}</strong>
        <span>Entrada: ${fmtData(o.data_ref)}</span>
        <span>${esc(o.status)}${o.status === 'Cancelado' ? ' (não entra nos totais)' : ''}</span>
        <span>Total: ${brl(o.valor_total)}</span>
        <span>Pago: ${brl(o.pago)}</span>
        <span>Saldo: ${brl(o.saldo)}</span>
      </div>
      <table class="rep-table">
        <thead><tr><th style="width:30%">Peça</th><th>Serviço</th><th style="width:120px">Empresa</th><th class="num" style="width:90px">Valor</th></tr></thead>
        <tbody>${o.itens.map((it) => `
          <tr>
            <td>${nomePeca(it)}</td>
            <td class="rep-fazer">${textoFazer(it)}</td>
            <td>${chipEmpresa(it.empresa)}</td>
            <td class="num">${it.subtotal > 0 ? brl(it.subtotal) : 'a definir'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`).join('');
  return html;
}

// "Tudo que falta fazer": todas as peças pendentes, de qualquer data, por OS ou agrupadas por empresa
function htmlRelPendentes(r, agrupar) {
  const sub = `Todas as peças pendentes, de qualquer data${r.empresa ? ' · Empresa: ' + r.empresa : ''} · OS Aguardando ou Em Produção · peças já prontas não aparecem`;
  let html = cabecalhoRelatorio('Tudo que falta fazer', sub);
  if (!r.ordens.length) return html + '<div class="rep-vazio">Não há nenhuma peça pendente. 🎉</div>';

  const entregaTxt = (o) => `${fmtData(o.data_entrega)}${o.data_entrega < r.hoje ? ' <span class="rep-atraso">ATRASADA</span>' : ''}`;
  const situacao = (it) => `<span class="rep-status st-${slug(it.status)}">${esc(it.status)}</span>`;

  if (agrupar === 'empresa') {
    const grupos = EMPRESAS.map((e) => ({ e, linhas: [] }));
    r.ordens.forEach((o) => o.itens.forEach((it) => {
      const g = grupos.find((x) => x.e === it.empresa);
      if (g) g.linhas.push({ o, it });
    }));
    html += grupos.filter((g) => g.linhas.length).map((g) => {
      const pecas = g.linhas.reduce((t, l) => t + (l.it.qtd || 1), 0);
      return `
        <div class="rep-h2">${chipEmpresa(g.e)} <span class="rep-sub">${pecas} peça(s)</span></div>
        <table class="rep-table">
          <thead><tr><th style="width:90px">OS</th><th style="width:16%">Cliente</th><th style="width:130px">Entrega</th><th style="width:22%">Peça</th><th>O que precisa fazer</th><th style="width:105px">Situação</th></tr></thead>
          <tbody>${g.linhas.map(({ o, it }) => `
            <tr>
              <td><strong>${esc(o.numero)}</strong></td>
              <td>${esc(o.cliente_nome)}</td>
              <td>${entregaTxt(o)}</td>
              <td>${nomePeca(it)}</td>
              <td class="rep-fazer">${textoFazer(it)}</td>
              <td>${situacao(it)}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
    }).join('');
  } else {
    html += r.ordens.map((o) => `
      <div class="rep-os">
        <div class="rep-os-head">
          <strong>${esc(o.numero)}</strong>
          <span>${esc(o.cliente_nome)}</span>
          <span>Entrega: ${entregaTxt(o)}</span>
          <span>${esc(o.status)}</span>
        </div>
        <table class="rep-table">
          <thead><tr><th style="width:30%">Peça</th><th>O que precisa fazer</th><th style="width:130px">Empresa</th><th style="width:110px">Situação</th></tr></thead>
          <tbody>${o.itens.map((it) => `
            <tr>
              <td>${nomePeca(it)}</td>
              <td class="rep-fazer">${textoFazer(it)}</td>
              <td>${chipEmpresa(it.empresa)}</td>
              <td>${situacao(it)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`).join('');
  }

  html += `
    <div class="rep-h2">Resumo</div>
    <div class="rep-resumo">
      <div><span>Ordens de serviço</span><strong>${r.totalOS}</strong></div>
      <div><span>Peças a fazer</span><strong>${r.totalPecas}</strong></div>
      ${EMPRESAS.map((e) => `<div><span>${esc(e)}</span><strong>${r.porEmpresa[e] || 0}</strong></div>`).join('')}
    </div>`;
  return html;
}

function imprimirRelatorio() {
  try { window.print(); } catch (err) { erroGenerico('Erro ao imprimir', err); }
}

async function salvarRelatorioPDF() {
  const nome = { producao: 'producao_' + ($('rp-data').value || hojeLocal()), pendentes: 'tudo_que_falta_fazer', clientes: 'lista_de_clientes', cliente: 'gastos_do_cliente' }[relAtual];
  try {
    const r = await ipcRenderer.invoke('salvar-relatorio-pdf', nome);
    if (r.ok) toast('PDF salvo com sucesso!');
  } catch (err) {
    erroGenerico('Erro ao salvar o PDF', err);
  }
}

// INICIALIZAÇÃO
window.addEventListener('DOMContentLoaded', () => {
  updateDateTime();
  showSection('dashboard');
});

// EXPOR FUNÇÕES PARA O ESCOPO GLOBAL (handlers onclick= do HTML)
Object.assign(window, {
  $, showSection, salvarCliente, cancelarEdicaoCliente, editarCliente, deletarCliente,
  adicionarBlocoPeca, removerBlocoPeca, atualizarServicosPeca, calcularTotalOS, calcularSaldoOS,
  salvarOS, mudarStatus, receberPagamento, exportarOSParaPNG, enviarWhatsApp,
  fecharModal, aplicarFiltrosOS, limparFiltrosOS, abrirOS, voltarParaOrdens, salvarDetalheOS, statusPecaMudou, statusOSDetalhe, detalheAcao, marcarSujo, pecaMudou, removerAdicional, buscaClienteDigitou, mostrarResultadosCliente, esconderResultadosCliente, tecladoBuscaCliente, selecionarClienteOS, limparClienteOS, nomeOSAlterado, adicionarServicoAdicional, abrirRelatorio, gerarRelatorio, imprimirRelatorio, salvarRelatorioPDF, mudarMes, escolherMesAno, irParaMesAtual, fazerBackup, restaurarBackup
});
