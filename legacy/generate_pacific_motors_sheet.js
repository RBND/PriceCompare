const ExcelJS = require('exceljs');
const path = require('path');

async function createPacificMotorsSheet() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PriceCompare App';
  const ws = wb.addWorksheet('Pacific Motors Inventory');

  ws.columns = [
    { header: 'Line #', key: 'line', width: 9 },
    { header: 'Item / Part Name', key: 'name', width: 36 },
    { header: 'GM Part Number', key: 'pn', width: 16 },
    { header: 'Availability at Pacific Motors', key: 'avail', width: 22 },
    { header: 'Price ($)', key: 'price', width: 14 },
    { header: 'Shipping', key: 'shipping', width: 16 },
    { header: 'eBay / Product URL', key: 'url', width: 50 },
    { header: 'Inventory Notes & Details', key: 'notes', width: 44 }
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  headerRow.height = 24;

  const rows = [
    {
      line: '#6',
      name: 'Right Rear Quarter Outer Panel (Coupe)',
      pn: '84453011',
      avail: 'YES (Multiple in Stock)',
      price: 349.99,
      shipping: 'Free Shipping',
      url: 'https://www.ebay.com/itm/296772916455',
      notes: 'OEM RH Quarter Outer Panel (eBay item 296772916455). Pacific Motors also stocks multiple colors (Torch Red, Arctic White, Laguna Blue) directly on their catalog.'
    },
    {
      line: '#10',
      name: 'Right Rear Quarter Panel Reinforcement',
      pn: '20980041',
      avail: 'Call / Inquire',
      price: 65.00,
      shipping: 'Calculated',
      url: 'https://pacificmotors.com/',
      notes: 'Not listed as standalone web SKU. Often sold attached with the quarter panel or available from their C7 shell part-outs upon inquiry.'
    },
    {
      line: '#11',
      name: 'Differential Oil Cooler Radiator (Z51)',
      pn: '22908627',
      avail: 'YES',
      price: 185.00,
      shipping: 'Free / Calculated',
      url: 'https://pacificmotors.com/product/differential-oil-cooler-radiator-22908627-oem-chevrolet-corvette-c7-2014-19/',
      notes: 'OEM C7 Differential Oil Cooler Radiator #22908627 in Pacific Motors active catalog.'
    },
    {
      line: '#16',
      name: 'Right Rear Upper Control Arm / Wishbone',
      pn: '84463637',
      avail: 'YES',
      price: 71.09,
      shipping: 'Free Shipping',
      url: 'https://www.ebay.com/itm/306598305708',
      notes: 'OEM Rear Right Upper Control Arm Wishbone (eBay item 306598305708 / Pacific Motors SKU).'
    },
    {
      line: '#17',
      name: 'Rear Suspension Toe Link / Adjuster Rod',
      pn: '23175952',
      avail: 'YES',
      price: 59.00,
      shipping: 'Free Shipping',
      url: 'https://pacificmotors.com/product/rear-suspension-control-arm-toe-link-23175952-oem-chevrolet-corvette-c7-2014-19/',
      notes: 'OEM Rear Toe / Adjuster Link #23175952 in stock.'
    },
    {
      line: '#18',
      name: 'Rear Shock Absorber (Z51 Non-Mag)',
      pn: '84513886',
      avail: 'Inquire',
      price: 65.00,
      shipping: 'Calculated',
      url: 'https://pacificmotors.com/',
      notes: 'Pacific Motors parts out complete rear subframe & suspension packages.'
    },
    {
      line: '#19',
      name: 'Right Rear Lower Control Arm',
      pn: '20965286',
      avail: 'YES',
      price: 149.00,
      shipping: 'Free Shipping',
      url: 'https://pacificmotors.com/product/rear-lower-control-arm-20965286-oem-chevrolet-corvette-c7-2014-19/',
      notes: 'OEM Right Rear Lower Control Arm #20965286 in stock.'
    },
    {
      line: '#20',
      name: 'Rear Suspension Mono-Leaf Spring (Manual)',
      pn: '22782496',
      avail: 'YES',
      price: 175.00,
      shipping: 'Calculated',
      url: 'https://pacificmotors.com/product/rear-suspension-leaf-spring-22782496-oem-chevrolet-corvette-c7-2014-19/',
      notes: 'OEM C7 Stingray manual rear transverse composite leaf spring #22782496.'
    },
    {
      line: '#23',
      name: 'Right Rear Quarter Marker / Signal Lamp',
      pn: '23210930',
      avail: 'YES',
      price: 39.99,
      shipping: 'Free Shipping',
      url: 'https://www.ebay.com/itm/277504534099',
      notes: 'OEM Rear Right Side Marker / Signal Lamp #23210930 (eBay item 277504534099).'
    },
    {
      line: '#25',
      name: 'Rear Upper Bumper Cover / Fascia Assembly',
      pn: '84411653',
      avail: 'YES',
      price: 450.00,
      shipping: 'Freight / Pickup',
      url: 'https://pacificmotors.com/product/rear-bumper-cover-fascia-assembly-oem-84411653-chevrolet-corvette-z51-c7-2014-19/',
      notes: 'OEM C7 Z51 Rear Upper Bumper Fascia #84411653 in stock.'
    },
    {
      line: '#28',
      name: 'Rear Bumper Energy Absorber (Foam)',
      pn: '84186343',
      avail: 'YES',
      price: 99.99,
      shipping: '19.99',
      url: 'https://www.ebay.com/itm/298731857428',
      notes: 'OEM Rear Bumper Foam Energy Absorber #84186343 (eBay item 298731857428).'
    },
    {
      line: '#29',
      name: 'Rear Bumper Aluminum Impact Bar / Cross Bar',
      pn: '84337474',
      avail: 'Inquire',
      price: 210.00,
      shipping: 'Freight',
      url: 'https://pacificmotors.com/',
      notes: 'Aluminum rear crash cross-bar (often unbolted from C7 rear clip upon request).'
    }
  ];

  rows.forEach((r) => {
    const row = ws.addRow(r);
    row.getCell(5).numFmt = '$#,##0.00';
  });

  const outPath = path.join(__dirname, 'Pacific_Motors_C7_Parts_List.xlsx');
  await wb.xlsx.writeFile(outPath);
  console.log(`Saved Pacific Motors sheet to: ${outPath}`);
}

createPacificMotorsSheet().catch(console.error);
