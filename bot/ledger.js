// Trade ledger: every buy / relist / sale the bot sees is saved and the spreadsheet is rebuilt.
//   data/trades.json            the raw ledger (source of truth)
//   data/trades.csv             plain copy, never locked by Excel
//   data/profit-vs-cost.xlsx    Summary + Trades sheets with live formulas (rebuilt after every change)
const fs = require('fs');
const path = require('path');
const { clean } = require('./strategy');

const DIR = path.join(process.cwd(), 'data');
const JSON_FILE = path.join(DIR, 'trades.json');
const CSV_FILE = path.join(DIR, 'trades.csv');
const XLSX_FILE = path.join(DIR, 'profit-vs-cost.xlsx');
const MAX_ROWS = 500;

const norm = (n) => clean(n).replace(/s$/, '');          // "Diamonds" == "diamond"
const sameItem = (a, b) => norm(a) === norm(b);

class Ledger {
  constructor(log = () => {}) {
    this.log = log;
    this.busy = false; this.dirty = false;
    this.d = { fee: 0, startBalance: null, lastBalance: null, nextId: 1, trades: [] };
    try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
    try { this.d = { ...this.d, ...JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')) }; } catch {}   // first run: starts empty
  }
  // ---- recording ----
  balance(n) { if (n > 0) { this.d.lastBalance = n; this.save(); } }
  addPurchase({ item, qty, cost, balanceBefore }) {
    if (this.d.startBalance == null && balanceBefore > 0) this.d.startBalance = balanceBefore;
    const t = { id: this.d.nextId++, time: new Date().toISOString(), item: clean(item), qty: qty || 1, cost, listPrice: null, status: 'Bought', note: 'bot purchase' };
    this.d.trades.push(t); this.save();
    return t.id;
  }
  setListed(id, listPrice) {
    const t = this.d.trades.find((x) => x.id === id);
    if (t) { t.listPrice = listPrice; t.status = 'Listed'; this.save(); }
  }
  // "<buyer> bought your Diamond for $15K": mark the closest-priced listing of that item as sold.
  markSold(item, price) {
    const open = this.d.trades.filter((t) => t.status === 'Listed' && sameItem(t.item, item));
    if (!open.length) return false;
    open.sort((a, b) => Math.abs(a.listPrice - price) - Math.abs(b.listPrice - price) || a.id - b.id);
    const t = open[0];
    if (Math.abs(t.listPrice - price) > Math.max(price * 0.02, 100)) return false; // price differs too much: not ours
    t.status = 'Sold'; t.soldAt = new Date().toISOString(); this.save();
    return true;
  }
  // ---- output ----
  save() {
    try { fs.writeFileSync(JSON_FILE, JSON.stringify(this.d, null, 1)); this.writeCsv(); } catch (e) { this.log('ledger save failed: ' + e.message); }
    this.dirty = true; this.flush();
  }
  writeCsv() {
    const rows = ['id,time,item,qty,cost,list_price,status'].concat(this.d.trades.map((t) => [t.id, t.time, t.item, t.qty, t.cost, t.listPrice ?? '', t.status].join(',')));
    fs.writeFileSync(CSV_FILE, rows.join('\n') + '\n');
  }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.dirty) { this.dirty = false; await this.writeXlsx(); }
    } catch (e) {
      this.log(e.code === 'MODULE_NOT_FOUND' ? 'spreadsheet skipped: run  npm install  once (CSV is still written)' : 'spreadsheet not updated (is it open in Excel? close it): ' + e.message);
    } finally { this.busy = false; }
  }
  // Pure numbers for the Summary, so the file also carries cached values.
  summary() {
    const fee = this.d.fee || 0, T = this.d.trades.filter((t) => t.listPrice != null);
    const sum = (f) => T.reduce((a, t) => a + f(t), 0);
    const sold = T.filter((t) => t.status === 'Sold'), listed = T.filter((t) => t.status === 'Listed');
    const net = (t) => t.listPrice * (1 - fee);
    const spent = this.d.trades.reduce((a, t) => a + t.cost, 0);
    const costSold = sold.reduce((a, t) => a + t.cost, 0), revSold = sold.reduce((a, t) => a + net(t), 0);
    const costListed = listed.reduce((a, t) => a + t.cost, 0), revListed = listed.reduce((a, t) => a + net(t), 0);
    return { spent, costSold, revSold, realized: revSold - costSold, costListed, revListed, sold: sold.length, listed: listed.length, sum, net };
  }
  async writeXlsx() {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Summary'), tr = wb.addWorksheet('Trades');
    const F = 'Arial', CUR = '$#,##0;($#,##0);-', PCT = '0.0%;(0.0%);-';
    const font = (o = {}) => ({ name: F, ...o });
    const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } }, box = { top: thin, bottom: thin, left: thin, right: thin };
    const fee = this.d.fee || 0, S = this.summary();

    // ---- Trades ----
    tr.getCell('A1').value = 'DonutSMP bot trades: cost vs profit'; tr.getCell('A1').font = font({ bold: true, size: 14 });
    tr.getCell('A2').value = 'Written automatically by the bot. Status: Bought = purchased, relist pending; Listed = for sale; Sold = sale seen in chat.';
    tr.getCell('A2').font = font({ italic: true, color: { argb: 'FF595959' } });
    const heads = ['#', 'Bought at', 'Item', 'Qty', 'Cost total ($)', 'Cost per item ($)', 'List price total ($)', 'List per item ($)', 'Status', 'Proceeds after fee ($)', 'Profit if sold ($)', 'ROI', 'Realized profit ($)'];
    heads.forEach((h, i) => {
      const c = tr.getCell(4, i + 1); c.value = h; c.font = font({ bold: true, color: { argb: 'FFFFFFFF' } });
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = box;
    });
    tr.getRow(4).height = 32;
    const trades = this.d.trades.slice(-MAX_ROWS);
    trades.forEach((t, i) => {
      const r = 5 + i, hasList = t.listPrice != null;
      const net = hasList ? t.listPrice * (1 - fee) : 0, profit = hasList ? net - t.cost : 0;
      const put = (col, v) => { const c = tr.getCell(r, col); c.value = v; c.font = font(); c.border = box; return c; };
      put(1, t.id); put(2, t.time.replace('T', ' ').slice(0, 16)); put(3, t.item); put(4, t.qty);
      put(5, t.cost).numFmt = CUR;
      put(6, { formula: `IF(D${r}>0,E${r}/D${r},0)`, result: t.qty ? t.cost / t.qty : 0 }).numFmt = CUR;
      put(7, hasList ? t.listPrice : null).numFmt = CUR;
      put(8, { formula: `IF(AND(D${r}>0,G${r}>0),G${r}/D${r},0)`, result: hasList && t.qty ? t.listPrice / t.qty : 0 }).numFmt = CUR;
      put(9, t.status);
      put(10, { formula: `IF(G${r}>0,G${r}*(1-Summary!$B$4),0)`, result: net }).numFmt = CUR;
      put(11, { formula: `IF(G${r}>0,J${r}-E${r},0)`, result: profit }).numFmt = CUR;
      put(12, { formula: `IF(AND(G${r}>0,E${r}>0),K${r}/E${r},0)`, result: hasList && t.cost ? profit / t.cost : 0 }).numFmt = PCT;
      put(13, { formula: `IF(I${r}="Sold",K${r},0)`, result: t.status === 'Sold' ? profit : 0 }).numFmt = CUR;
    });
    const last = 4 + Math.max(trades.length, 1), tot = last + 1;
    tr.getCell(tot, 3).value = 'Total'; tr.getCell(tot, 3).font = font({ bold: true });
    [[4, 'D'], [5, 'E'], [7, 'G'], [10, 'J'], [11, 'K'], [13, 'M']].forEach(([c, L]) => {
      const x = tr.getCell(tot, c); x.value = { formula: `SUM(${L}5:${L}${last})` }; x.font = font({ bold: true }); x.numFmt = c === 4 ? '0' : CUR;
    });
    [6, 17, 14, 6, 14, 14, 16, 14, 10, 18, 15, 9, 16].forEach((w, i) => { tr.getColumn(i + 1).width = w; });
    tr.views = [{ state: 'frozen', xSplit: 3, ySplit: 4 }];

    // ---- Summary ----
    ws.getCell('A1').value = 'DonutSMP bot: profit vs cost'; ws.getCell('A1').font = font({ bold: true, size: 14 });
    ws.getCell('A2').value = `Updated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC by the bot. All figures come from the Trades sheet.`;
    ws.getCell('A2').font = font({ italic: true, color: { argb: 'FF595959' } });
    ws.getCell('A3').value = 'Assumptions'; ws.getCell('A3').font = font({ bold: true });
    ws.getCell('A4').value = 'Sale fee (% taken from each sale)'; ws.getCell('A4').font = font();
    const f4 = ws.getCell('B4'); f4.value = fee; f4.numFmt = '0.0%'; f4.font = font({ color: { argb: 'FF0000FF' } }); f4.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
    ws.getCell('C4').value = 'Edit this in Excel if you find DonutSMP takes a fee. The bot keeps it (data/trades.json: "fee").'; ws.getCell('C4').font = font({ italic: true });
    ws.getCell('A6').value = 'Results'; ws.getCell('A6').font = font({ bold: true });
    const rng = (L) => `Trades!${L}5:${L}${last}`;
    const lines = [
      ['Total spent on all purchases ($)', `SUM(${rng('E')})`, S.spent, CUR],
      ['Cost of sold trades ($)', `SUMIFS(${rng('E')},${rng('I')},"Sold")`, S.costSold, CUR],
      ['Revenue from sold trades after fee ($)', `SUMIFS(${rng('J')},${rng('I')},"Sold")`, S.revSold, CUR],
      ['Realized profit ($)', 'B9-B8', S.realized, CUR],
      ['Realized ROI on sold trades', 'IF(B8>0,B10/B8,0)', S.costSold ? S.realized / S.costSold : 0, PCT],
      ['Cost tied up in unsold listings ($)', `SUMIFS(${rng('E')},${rng('I')},"Listed")`, S.costListed, CUR],
      ['Expected revenue if listings sell ($)', `SUMIFS(${rng('J')},${rng('I')},"Listed")`, S.revListed, CUR],
      ['Expected extra profit if listings sell ($)', 'B13-B12', S.revListed - S.costListed, CUR],
      ['Total profit if everything sells ($)', 'B10+B14', S.realized + S.revListed - S.costListed, CUR],
      ['Bought, not yet listed ($ cost)', `SUMIFS(${rng('E')},${rng('I')},"Bought")`, this.d.trades.filter((t) => t.status === 'Bought').reduce((a, t) => a + t.cost, 0), CUR],
      ['Trades sold / listed', `COUNTIF(${rng('I')},"Sold")&" sold / "&COUNTIF(${rng('I')},"Listed")&" listed"`, `${S.sold} sold / ${S.listed} listed`, '@'],
    ];
    lines.forEach(([label, formula, result, nf], i) => {
      const r = 7 + i, a = ws.getCell(r, 1), b = ws.getCell(r, 2);
      a.value = label; a.font = font(); a.border = box;
      b.value = { formula, result }; b.numFmt = nf; b.border = box; b.font = font({ bold: /^(Realized profit|Total profit)/.test(label) });
    });
    // balance check
    const sb = this.d.startBalance, lb = this.d.lastBalance;
    ws.getCell('A20').value = 'Balance check (from /bal readings)'; ws.getCell('A20').font = font({ bold: true });
    const chk = [
      ['Balance before the first purchase ($)', sb, null, true], ['Latest balance seen ($)', lb, null, true],
      ['Actual change ($)', null, ['B22-B21', (lb ?? 0) - (sb ?? 0)]], ['Expected change = sold revenue - all purchases ($)', null, ['B9-B7', S.revSold - S.spent]],
      ['Difference (should be 0)', null, ['B23-B24', ((lb ?? 0) - (sb ?? 0)) - (S.revSold - S.spent)]],
    ];
    chk.forEach(([label, v, f, input], i) => {
      const r = 21 + i, a = ws.getCell(r, 1), b = ws.getCell(r, 2);
      a.value = label; a.font = font(); a.border = box; b.numFmt = CUR; b.border = box;
      if (f) { b.value = { formula: f[0], result: f[1] }; b.font = font(); } else { b.value = v; b.font = font({ color: { argb: 'FF0000FF' } }); }
    });
    ws.getCell('B25').font = font({ bold: true });
    ws.getCell('C25').value = { formula: 'IF(B25=0,"OK: trades match your real balance","Check: a buy, sale or manual action is not in Trades")', result: '' };
    ws.getCell('C25').font = font({ bold: true });
    ws.getColumn(1).width = 52; ws.getColumn(2).width = 18; ws.getColumn(3).width = 60;

    const tmp = XLSX_FILE + '.tmp';
    await wb.xlsx.writeFile(tmp);
    fs.renameSync(tmp, XLSX_FILE);
  }
}

module.exports = { Ledger, norm };
