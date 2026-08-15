const PDFDocument = require('pdfkit');

const fmtR$ = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
const fmtData = d => d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—';

function orcamentoPdf(orc, grafica, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  doc.pipe(res);

  doc.fontSize(20).fillColor('#1a1a1a').text(grafica.nome || 'Gráfica');
  doc.fontSize(11).fillColor('#999').text(`Orçamento Nº ${String(orc.id).padStart(4, '0')}`);
  doc.moveDown(1.2);
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#dddddd').stroke();
  doc.moveDown(1);

  const colY = doc.y;
  doc.fontSize(9).fillColor('#999').text('CLIENTE', 56, colY);
  doc.fontSize(9).fillColor('#999').text('EMITIDO EM', 340, colY);
  doc.fontSize(12).fillColor('#1a1a1a').text(orc.capelido || orc.cnome, 56, colY + 14);
  doc.fontSize(12).fillColor('#1a1a1a').text(fmtData(orc.criado_em), 340, colY + 14);
  let nextY = colY + 32;
  if (orc.ctel) { doc.fontSize(10).fillColor('#555').text(orc.ctel, 56, nextY); }
  if (orc.validade) { doc.fontSize(9).fillColor('#999').text('VÁLIDO ATÉ', 340, nextY); doc.fontSize(12).fillColor('#1a1a1a').text(fmtData(orc.validade), 340, nextY + 12); }
  doc.y = nextY + (orc.validade ? 32 : 18);
  doc.moveDown(1);

  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#dddddd').stroke();
  doc.moveDown(0.8);

  const tableTop = doc.y;
  doc.fontSize(9).fillColor('#999');
  doc.text('DESCRIÇÃO', 56, tableTop);
  doc.text('TIPO', 320, tableTop);
  doc.text('QTD', 420, tableTop, { width: 40, align: 'right' });
  doc.text('VALOR', 460, tableTop, { width: 79, align: 'right' });
  doc.moveDown(0.6);
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#eeeeee').stroke();
  doc.moveDown(0.6);

  const rowTop = doc.y;
  doc.fontSize(11).fillColor('#1a1a1a');
  doc.text(orc.descricao, 56, rowTop, { width: 250 });
  doc.text(orc.tipo || 'Outros', 320, rowTop, { width: 90 });
  doc.text(String(orc.quantidade || 1), 420, rowTop, { width: 40, align: 'right' });
  doc.text(fmtR$(orc.valor_total), 460, rowTop, { width: 79, align: 'right' });
  doc.moveDown(1.4);

  if (orc.observacoes) {
    doc.fontSize(9).fillColor('#999').text('OBSERVAÇÕES');
    doc.fontSize(10).fillColor('#555').text(orc.observacoes, { width: 483 });
    doc.moveDown(1);
  }

  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#dddddd').stroke();
  doc.moveDown(0.8);
  doc.fontSize(10).fillColor('#999').text('TOTAL', 56, doc.y, { continued: false });
  doc.fontSize(18).fillColor('#1a1a1a').text(fmtR$(orc.valor_total), 56, doc.y, { width: 483, align: 'right' });
  doc.moveDown(3);

  doc.fontSize(8).fillColor('#aaaaaa').text(
    'Este orçamento é uma proposta de valores e prazos, sujeita a alteração sem aviso prévio. ' +
    (orc.validade ? `Válido até ${fmtData(orc.validade)}.` : 'Consulte a validade com a gráfica.'),
    56, doc.y, { width: 483, align: 'center' }
  );

  doc.end();
}

module.exports = { orcamentoPdf };
