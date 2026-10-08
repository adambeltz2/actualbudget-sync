// Renders the Monte Carlo page's "Export Report" PDF, matching the layout
// already shown on the page itself: header, three stat boxes, the
// percentile-band chart drawn as vector paths (not an embedded raster), an
// assumptions strip, and a disclaimer footer.
const PDFDocument = require('pdfkit');

function fmtShort(v) {
  if (Math.abs(v) >= 1000000) return '$' + (v / 1000000).toFixed(1) + 'M';
  if (Math.abs(v) >= 1000) return '$' + Math.round(v / 1000) + 'K';
  return '$' + Math.round(v);
}

function fmtFull(v) {
  return '$' + Math.round(v).toLocaleString('en-US');
}

const COLORS = {
  text: '#1E2A32', muted: '#8A93A0', border: '#F0EFEB', accent: '#0EA894',
  bandOuter: '#D7F0EC', bandInner: '#A9E1D8'
};

// Draws the percentile fan (p10-p90 and p25-p75 shaded bands, p50 as a
// solid line) inside the given rectangle using pdfkit's own path drawing —
// a real vector chart, not a screenshot of the HTML page.
function drawFanChart(doc, { x, y, width, height, ages, bands }) {
  const allValues = [...bands.p10, ...bands.p90];
  const maxValue = Math.max(...allValues, 1);
  const minValue = 0;
  const xForAge = i => x + (i / (ages.length - 1)) * width;
  const yForValue = v => y + height - ((v - minValue) / (maxValue - minValue)) * height;

  function bandPath(lowerArr, upperArr) {
    doc.moveTo(xForAge(0), yForValue(lowerArr[0]));
    for (let i = 1; i < ages.length; i++) doc.lineTo(xForAge(i), yForValue(lowerArr[i]));
    for (let i = ages.length - 1; i >= 0; i--) doc.lineTo(xForAge(i), yForValue(upperArr[i]));
    doc.closePath();
  }

  // gridlines
  doc.strokeColor(COLORS.border).lineWidth(0.5);
  for (let g = 0; g <= 4; g++) {
    const gy = y + (g / 4) * height;
    doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
    const value = maxValue * (1 - g / 4);
    doc.fontSize(7).fillColor(COLORS.muted).text(fmtShort(value), x - 2, gy - 7, { width: 50, align: 'left' });
  }

  doc.fillColor(COLORS.bandOuter);
  bandPath(bands.p10, bands.p90);
  doc.fill();
  doc.fillColor(COLORS.bandInner);
  bandPath(bands.p25, bands.p75);
  doc.fill();

  doc.strokeColor(COLORS.accent).lineWidth(1.5);
  doc.moveTo(xForAge(0), yForValue(bands.p50[0]));
  for (let i = 1; i < ages.length; i++) doc.lineTo(xForAge(i), yForValue(bands.p50[i]));
  doc.stroke();

  // x-axis age labels, sparse
  doc.fontSize(7).fillColor(COLORS.muted);
  const step = Math.ceil(ages.length / 8);
  for (let i = 0; i < ages.length; i += step) {
    doc.text(String(ages[i]), xForAge(i) - 8, y + height + 4, { width: 16, align: 'center' });
  }
}

/**
 * @param {object} params
 * @param {object} params.result - output of simulateRetirement
 * @param {object} params.scenario - the scenario inputs (allocation, inflationPct, etc.)
 * @returns {Promise<Buffer>}
 */
function buildMonteCarloPdf({ result, scenario, generatedAt = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, 612, 6).fill(COLORS.accent);
    doc.moveDown(2);

    doc.fillColor(COLORS.text).fontSize(19).font('Helvetica-Bold').text('Retirement Analysis Report', 50, 40);
    doc.fontSize(10).font('Helvetica').fillColor(COLORS.muted)
      .text('Actual Budget Smart Sync · Monte Carlo projection', 50, 64);
    doc.fontSize(9).fillColor(COLORS.muted)
      .text(`Generated ${generatedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, 400, 40, { width: 162, align: 'right' })
      .text(`${result.paths.toLocaleString('en-US')} simulated paths`, 400, 54, { width: 162, align: 'right' });

    doc.moveTo(50, 90).lineTo(562, 90).lineWidth(2).strokeColor(COLORS.accent).stroke();

    const stats = [
      ['Probability of Success', `${result.successPct}%`],
      ['Median Ending Balance', fmtShort(result.medianEndingBalance)],
      ['Safe Withdrawal', `${fmtFull(result.safeWithdrawalAmount)}/yr`]
    ];
    const boxWidth = 160, boxGap = 16, boxTop = 106, boxHeight = 56;
    stats.forEach(([label, value], i) => {
      const bx = 50 + i * (boxWidth + boxGap);
      doc.roundedRect(bx, boxTop, boxWidth, boxHeight, 6).strokeColor(COLORS.border).lineWidth(1).stroke();
      doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica-Bold').text(label.toUpperCase(), bx + 12, boxTop + 10, { width: boxWidth - 24 });
      doc.fontSize(18).fillColor(COLORS.text).font('Helvetica-Bold').text(value, bx + 12, boxTop + 26);
    });

    doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica-Bold')
      .text(`SIMULATED BALANCE RANGE · AGE ${result.ages[0]} → ${result.ages[result.ages.length - 1]}`, 50, 182);
    drawFanChart(doc, { x: 60, y: 200, width: 492, height: 240, ages: result.ages, bands: result.bands });

    const assumpY = 468;
    doc.moveTo(50, assumpY).lineTo(562, assumpY).lineWidth(1).strokeColor(COLORS.border).stroke();
    const assumptions = [
      ['Expected return (nominal)', `${(scenario.allocationMean * 100).toFixed(1)}% ± ${(scenario.allocationVol * 100).toFixed(1)}%`],
      ['Inflation', `${scenario.inflationPct.toFixed(1)}%`],
      ['Withdrawal rate', `${scenario.withdrawalRatePct.toFixed(1)}%`],
      ['Target retirement', `Age ${result.retireAge}`]
    ];
    const assumpColWidth = 128;
    assumptions.forEach(([label, value], i) => {
      const ax = 50 + i * assumpColWidth;
      doc.fontSize(9).fillColor(COLORS.text).font('Helvetica-Bold').text(label, ax, assumpY + 10, { width: assumpColWidth - 10 });
      doc.fontSize(9).font('Helvetica').text(value, ax, assumpY + 22, { width: assumpColWidth - 10 });
    });

    doc.fontSize(7.5).fillColor('#A7AEB6').font('Helvetica')
      .text(
        'This report is a Monte Carlo projection from your own synced data and the assumptions above. It is not a guarantee of future performance and does not account for taxes or fees. Treat it as a starting point for a conversation with a licensed financial advisor, not a plan.',
        50, 560, { width: 512 }
      );

    doc.end();
  });
}

module.exports = { buildMonteCarloPdf, fmtShort, fmtFull };
