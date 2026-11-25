const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

// O banco só é aberto quando initDb() é chamado (depois do app estar pronto).
// Use sempre `database.db` (e não desestruture), pois ele é atribuído em initDb().
const database = { db: null, initDb };

function initDb() {
  if (database.db) return database.db;

  const dbPath = path.join(app.getPath('userData'), 'sos_roupas.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tel TEXT NOT NULL,
      endereco TEXT,
      cidade TEXT,
      obs TEXT,
      medidas TEXT,
      cadastro DATE DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS ordens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT UNIQUE NOT NULL,
      cliente_id INTEGER,
      cliente_nome TEXT,
      cliente_tel TEXT,
      valor_total REAL DEFAULT 0,
      sinal REAL DEFAULT 0,
      saldo REAL DEFAULT 0,
      data_entrada DATE,
      data_entrega DATE,
      status TEXT DEFAULT 'Aguardando',
      descricao_geral TEXT,
      medidas_obs TEXT,
      criado DATE DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(cliente_id) REFERENCES clientes(id)
    );

    CREATE TABLE IF NOT EXISTS os_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      os_id INTEGER NOT NULL,
      tipo TEXT,
      servico TEXT,
      peca TEXT,
      cor TEXT,
      qtd INTEGER DEFAULT 1,
      valor REAL DEFAULT 0,
      FOREIGN KEY(os_id) REFERENCES ordens(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      os_id INTEGER NOT NULL,
      valor REAL NOT NULL,
      forma_pagamento TEXT NOT NULL, -- Pix, Dinheiro, Cartão de Crédito/Débito
      data_pagamento DATE DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY(os_id) REFERENCES ordens(id) ON DELETE CASCADE
    );
  `);

  // Serviços adicionais de cada peça (ex.: "Fazer bainha", "Trocar botão")
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_servicos_adicionais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      valor REAL DEFAULT 0,
      FOREIGN KEY(item_id) REFERENCES os_itens(id) ON DELETE CASCADE
    );
  `);

  // Migrações: bancos criados por versões anteriores ganham as colunas novas 
  const colunas = (tabela) => db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
  const colsItens = colunas('os_itens');
  if (!colsItens.includes('obs')) db.exec("ALTER TABLE os_itens ADD COLUMN obs TEXT DEFAULT ''");
  if (!colsItens.includes('empresa')) db.exec("ALTER TABLE os_itens ADD COLUMN empresa TEXT DEFAULT 'SOS Roupas'");
  if (!colsItens.includes('status')) {
    db.exec("ALTER TABLE os_itens ADD COLUMN status TEXT DEFAULT 'A fazer'");
    // OS que já estavam prontas/entregues: suas peças já estão feitas
    db.exec("UPDATE os_itens SET status = 'Pronta' WHERE os_id IN (SELECT id FROM ordens WHERE status IN ('Pronto', 'Entregue'))");
  }

  // Nome e telefone das OS acompanham sempre o cadastro do cliente (corrige OS antigas com telefone desatualizado)
  db.exec(`
    UPDATE ordens
       SET cliente_nome = (SELECT nome FROM clientes WHERE id = ordens.cliente_id),
           cliente_tel  = (SELECT tel  FROM clientes WHERE id = ordens.cliente_id)
     WHERE cliente_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM clientes WHERE id = ordens.cliente_id)
  `);

  database.db = db;
  return db;
}

module.exports = database;
