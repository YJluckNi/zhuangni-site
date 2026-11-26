/* 减值记录：在浏览器里生成 Excel（无依赖，store 压缩） */
(function (root) {
  "use strict";
  function crcTable() {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  }
  var CRC_TABLE = crcTable();
  function crc32(buf) {
    var c = -1;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function u16(n) { var b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
  function u32(n) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
  function concat(arr) {
    var n = 0, i;
    for (i = 0; i < arr.length; i++) n += arr[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arr.length; i++) { out.set(arr[i], o); o += arr[i].length; }
    return out;
  }
  function enc(s) { return new TextEncoder().encode(s); }
  function zipStore(entries) {
    var parts = [], central = [], offset = 0;
    for (var e = 0; e < entries.length; e++) {
      var name = enc(entries[e].name);
      var data = entries[e].data;
      var crc = crc32(data);
      var lh = concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)]);
      parts.push(lh, name, data);
      var cd = concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)]);
      central.push(cd, name);
      offset += lh.length + name.length + data.length;
    }
    var cdBuf = concat(central);
    var eocd = concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdBuf.length), u32(offset), u16(0)]);
    return concat(parts.concat([cdBuf, eocd]));
  }
  function xmlEsc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function colName(i) {
    var s = "";
    i = i + 1;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function buildSheet(rows) {
    var body = rows.map(function (row, r) {
      var cells = row.map(function (v, c) {
        var ref = colName(c) + (r + 1);
        if (v == null || v === "") return "";
        if (typeof v === "number" && isFinite(v)) return '<c r="' + ref + '"><v>' + v + "</v></c>";
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + "</t></is></c>";
      }).join("");
      return '<row r="' + (r + 1) + '">' + cells + "</row>";
    }).join("");
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + "</sheetData></worksheet>";
  }
  function build(daily, today, E) {
    daily = (daily || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var series = E.buildSeries(daily, today || E.todayISO());
    var emaMap = {};
    series.forEach(function (s) { emaMap[s.date] = s.ema; });
    var rows = [["日期", "星期", "体重(kg)", "睡眠(h)", "步数", "运动", "运动消耗(kcal)", "饮食", "饮食热量(kcal)", "放纵餐", "7日趋势EMA(kg)", "备注"]];
    daily.forEach(function (d) {
      var mealList = E.mealsOf(d);
      rows.push([
        d.date, E.formatWeekday(d.date),
        d.weight == null ? "" : Number(d.weight),
        d.sleep == null ? "" : Number(d.sleep),
        d.steps == null ? "" : Number(d.steps),
        E.workoutText(d) || "",
        E.workoutsOf(d).length ? E.workoutTotal(d) : "",
        mealList.map(function (m) { return E.mealLabel(m.slot) + " " + (m.text || "") + (m.kcal == null ? "" : "（" + m.kcal + "kcal）"); }).join(" | "),
        mealList.length ? mealList.reduce(function (a, m) { return a + (isFinite(m.kcal) ? +m.kcal : 0); }, 0) : "",
        d.cheat ? "是" : "",
        emaMap[d.date] == null ? "" : Math.round(emaMap[d.date] * 100) / 100,
        d.note || ""
      ]);
    });
    function x(s) { return enc(s); }
    var files = [
      { name: "[Content_Types].xml", data: x('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
      { name: "_rels/.rels", data: x('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: "xl/workbook.xml", data: x('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="每日记录" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: x('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
      { name: "xl/styles.xml", data: x('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="宋体"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>') },
      { name: "xl/worksheets/sheet1.xml", data: x(buildSheet(rows)) }
    ];
    return new Blob([zipStore(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  function download(daily, today, E) {
    var blob = build(daily, today, E);
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "减值记录-" + (today || "export") + ".xlsx";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  root.JZXlsx = { build: build, download: download };
})(window);
