/*
 * 极简 XLSX 生成器（零依赖）—— 浏览器版
 * 来源：计划拆解/lib/xlsx.js，ZIP 部分从 Node Buffer 改为 Uint8Array；build() 返回 Uint8Array。
 */
(function (global) {
'use strict';



/* ---------- CRC32 ---------- */
var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- ZIP (stored)，浏览器版：Uint8Array + TextEncoder ---------- */
var ENC = new TextEncoder();
function u8(s) { return typeof s === 'string' ? ENC.encode(s) : s; }
function concat(list) {
  var len = 0;
  list.forEach(function (a) { len += a.length; });
  var out = new Uint8Array(len), off = 0;
  list.forEach(function (a) { out.set(a, off); off += a.length; });
  return out;
}
function zip(files) {
  var parts = [];
  var central = [];
  var offset = 0;
  var d = new Date();
  var dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  var dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

  files.forEach(function (f) {
    var name = u8(f.name);
    var data = u8(f.data);
    var crc = crc32(data);

    var local = new Uint8Array(30), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    parts.push(local, name, data);

    var cd = new Uint8Array(46), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(30, 0, true);
    cv.setUint32(34, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  });

  var cdBuf = concat(central);
  var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdBuf.length, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  return concat(parts.concat([cdBuf, eocd]));
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(n) {
  var s = '';
  n = n + 1;
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

var STYLE = {
  DEFAULT: 0,
  HEADER: 1,
  BODY: 2,
  TITLE: 3,
  CENTER: 4,
  SUBTITLE: 5,
  FOOTER: 6
};

/* ---------- 样式表 ---------- */
var STYLES_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  '<fonts count="5">',
  '<font><sz val="10.5"/><color rgb="FF1F2937"/><name val="等线"/><charset val="134"/></font>',
  '<font><b/><sz val="10.5"/><color rgb="FFFFFFFF"/><name val="等线"/><charset val="134"/></font>',
  '<font><b/><sz val="15"/><color rgb="FF1B3A5B"/><name val="等线"/><charset val="134"/></font>',
  '<font><sz val="9"/><color rgb="FF808080"/><name val="等线"/><charset val="134"/></font>',
  '<font><sz val="10"/><color rgb="FF64748B"/><name val="等线"/><charset val="134"/></font>',
  '</fonts>',
  '<fills count="4">',
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1B4B75"/><bgColor indexed="64"/></patternFill></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>',
  '</fills>',
  '<borders count="2">',
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  '<border><left style="thin"><color rgb="FFD8E0E9"/></left><right style="thin"><color rgb="FFD8E0E9"/></right><top style="thin"><color rgb="FFD8E0E9"/></top><bottom style="thin"><color rgb="FFD8E0E9"/></bottom><diagonal/></border>',
  '</borders>',
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
  '<cellXfs count="7">',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>',
  '</cellXfs>',
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
  '</styleSheet>'
].join('');

/* ---------- 主体 ---------- */
function build(opts) {
  opts = opts || {};
  var sheetName = String(opts.sheetName || 'Sheet1').replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31) || 'Sheet1';
  var headers = opts.headers || [];
  var widths = opts.widths || [];
  var rows = opts.rows || [];
  var centerCols = opts.centerCols || [];
  var colCount = Math.max(headers.length, 1);

  var xml = [];
  xml.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  xml.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');

  var totalRows = rows.length + 4 + (opts.footer ? 2 : 0);
  xml.push('<dimension ref="A1:' + colName(colCount - 1) + Math.max(totalRows, 1) + '"/>');
  xml.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  xml.push('<sheetFormatPr defaultRowHeight="18"/>');

  if (widths.length) {
    xml.push('<cols>');
    widths.forEach(function (w, i) {
      xml.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>');
    });
    xml.push('</cols>');
  }

  xml.push('<sheetData>');

  var r = 1;
  // 标题
  xml.push('<row r="1" ht="28" customHeight="1">' +
    '<c r="A1" s="' + STYLE.TITLE + '" t="inlineStr"><is><t>' + esc(opts.title || '') + '</t></is></c></row>');
  // 副标题
  xml.push('<row r="2" ht="20" customHeight="1">' +
    '<c r="A2" s="' + STYLE.SUBTITLE + '" t="inlineStr"><is><t>' + esc(opts.subtitle || '') + '</t></is></c></row>');
  // 空行
  xml.push('<row r="3"/>');
  // 表头
  r = 4;
  var headCells = headers.map(function (h, i) {
    return '<c r="' + colName(i) + r + '" s="' + STYLE.HEADER + '" t="inlineStr"><is><t>' + esc(h) + '</t></is></c>';
  }).join('');
  xml.push('<row r="' + r + '" ht="24" customHeight="1">' + headCells + '</row>');

  // 数据
  rows.forEach(function (row, ri) {
    r = 5 + ri;
    var cells = [];
    for (var c = 0; c < colCount; c++) {
      var v = row[c];
      var ref = colName(c) + r;
      var isNum = typeof v === 'number' && isFinite(v);
      var style = centerCols.indexOf(c) >= 0 ? STYLE.CENTER : STYLE.BODY;
      if (isNum) {
        cells.push('<c r="' + ref + '" s="' + style + '"><v>' + v + '</v></c>');
      } else if (v === '' || v == null) {
        cells.push('<c r="' + ref + '" s="' + style + '"/>');
      } else {
        cells.push('<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>');
      }
    }
    var ht = opts.rowHeight || 22;
    xml.push('<row r="' + r + '" ht="' + ht + '" customHeight="1">' + cells.join('') + '</row>');
  });

  if (opts.footer) {
    r = 5 + rows.length + 1;
    xml.push('<row r="' + r + '"><c r="A' + r + '" s="' + STYLE.FOOTER + '" t="inlineStr"><is><t>' + esc(opts.footer) + '</t></is></c></row>');
  }

  xml.push('</sheetData>');

  // 合并标题
  xml.push('<mergeCells count="1"><mergeCell ref="A1:' + colName(colCount - 1) + '1"/></mergeCells>');
  xml.push('</worksheet>');

  var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + esc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';

  var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', data: xml.join('') }
  ]);
}

global.WBSXLSX = { build: build, colName: colName };

})(typeof self !== "undefined" ? self : this);
