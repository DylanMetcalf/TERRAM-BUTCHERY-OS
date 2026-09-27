/**
 * 50-order acceptance fixture. Each entry is what a customer sent, plus the
 * ground truth a careful person would write down. Items are [slug, quantity, preparation?].
 * Quantities: '2kg' / '500g' weight · 4 count · '6x500g' portions.
 */
export type Truth = [slug: string, qty: string | number, prep?: Record<string, string>];
export interface Entry {
  name: string;
  text: string;
  /** Final expected items once the whole chat is read (null = must NOT be auto-confirmed). */
  expect: Truth[] | null;
  fulfilment?: 'collection' | 'delivery';
}

export const ORDERS: Entry[] = [
  { name: 'Anna Venter', text: '2kg mince\n4 rumps\nCollect Saturday', expect: [['beef_mince', '3kg'], ['beef_rump', 4]], fulfilment: 'collection' },
  { name: 'Ben Coetzee', text: '6 fillets, 1kg boerewors', expect: [['beef_fillet', 6], ['boerewors', '1kg']] },
  { name: 'Carla Joubert', text: '3kg chicken breasts\nDelivery Friday\n12 Oak Street, Parys', expect: [['chicken_breast', '3kg']], fulfilment: 'delivery' },
  { name: 'David Nel', text: 'Hi, can I please get 2 ribeye on the bone and 1.5kg wors for Saturday? Thanks', expect: [['beef_ribeye', 3, { Bone: 'Bone-in' }], ['boerewors', '1.5kg']] },
  { name: 'Elsa Botha', text: 'leg of lamb x1 deboned\n2kg lamb chops', expect: [['lamb_leg', 1, { Bone: 'Deboned & rolled' }], ['lamb_chops', '2kg']] },
  { name: 'Frans Meyer', text: '10 burger patties\n2kg chicken wings\npick up thursday', expect: [['beef_burger', 10], ['chicken_wings', '2kg'], ['bacon', '1kg']], fulfilment: 'collection' },
  { name: 'Gugu Ndlovu', text: '1 whole chicken spatchcocked\n500g bacon', expect: [['chicken_whole', 2, { Cut: 'Spatchcocked' }], ['bacon', '500g']] },
  { name: 'Hennie du Toit', text: '4 x 500g mince, 6 pork chops', expect: [['beef_mince', '4x500g'], ['pork_chops', 6]] },
  { name: 'Ilse Kruger', text: '2kg short rib\n2.5kg brisket\nsoup bones 2kg', expect: [['beef_short_rib', '2kg'], ['beef_brisket', '2.5kg'], ['soup_bones', '2kg']] },
  { name: 'Jaco Smit', text: '3 T-bones thick cut', expect: [['beef_tbone', 3, { Thickness: 'Thick cut' }], ['boerewors', '2kg']] },
  { name: 'Karabo Mokoena', text: '2 lamb shanks\n1kg stewing beef\n1kg oxtail', expect: [['lamb_shank', 2], ['beef_stewing', '1kg'], ['beef_oxtail', '1kg']] },
  { name: 'Lindi Zulu', text: 'rump steak x 6, vacuum packed', expect: [['beef_rump', 6, { Packing: 'Vacuum packed' }]] },
  { name: 'Marius Venter', text: '2 kilos boerewors\n1 kilo mince', expect: [['boerewors', '2kg'], ['beef_mince', '1kg']] },
  { name: 'Nomsa Dube', text: 'half a kilo bacon, 6 drumsticks', expect: [['bacon', '500g'], ['chicken_drumsticks', 6]] },
  { name: 'Oupa Mahlangu', text: '1 rack of lamb, 4 lamb chops', expect: [['lamb_rack', 1], ['lamb_chops', 4]] },
  { name: 'Petro Lombard', text: 'Sirloin x4\nRibeye x2 boneless', expect: [['beef_sirloin', 4], ['beef_ribeye', 2]] },
  { name: 'Quinton Adams', text: '2kg pork belly skin on\n1kg spare ribs basted', expect: [['pork_belly', '2kg'], ['pork_ribs', '1kg', { Style: 'Basted' }]] },
  { name: 'Rina Swart', text: '3kg mince lean', expect: [['beef_mince', '3kg', { Fat: 'Lean' }]] },
  { name: 'Sipho Khumalo', text: '2 whole chickens', expect: [['chicken_whole', 2]] },
  { name: 'Tanya Pillay', text: '1kg chicken thighs boneless skinless', expect: [['chicken_thighs', '1kg', { Bone: 'Boneless', Skin: 'Skinless' }]] },
  { name: 'Ulrich Schoeman', text: 'gammon 2kg', expect: [['gammon', '2kg']] },
  { name: 'Vusi Nkosi', text: '5 rumps\n5 sirloins', expect: [['beef_rump', 5], ['beef_sirloin', 5]] },
  { name: 'Wilma Fourie', text: '1.5kg topside roast', expect: [['beef_topside', '1.5kg']] },
  { name: 'Xolani Mthembu', text: '4kg boerewors for the braai saturday', expect: [['boerewors', '4kg']] },
  { name: 'Yolandi Kotze', text: '6 x 250g fillet', expect: [['beef_fillet', '6x250g']] },
  { name: 'Zanele Moyo', text: '2kg beef shin', expect: [['beef_shin', '2kg']] },
  { name: 'Annatjie Roux', text: '3 lamb shoulders cubed', expect: [['lamb_shoulder', 3, { Cut: 'Cubed' }]] },
  { name: 'Bongani Sithole', text: '12 large burger patties', expect: [['beef_burger', 12, { Size: '200g' }]] },
  { name: 'Charl Visser', text: 'pork loin roast 2kg', expect: [['pork_loin', '2kg']] },
  { name: 'Dineo Molefe', text: 'chicken wings 3kg\nchicken drumsticks 2kg', expect: [['chicken_wings', '3kg'], ['chicken_drumsticks', '2kg']] },
  { name: 'Eben Pretorius', text: 'Can I order 8 lamb loin chops and 1kg lamb neck', expect: [['lamb_chops', 8], ['lamb_neck', '1kg']] },
  { name: 'Fatima Essop', text: '2kg stewing beef strips for stir fry', expect: [['beef_stewing', '2kg', { Cut: 'Strips' }]] },
  { name: 'Gerrit Bosman', text: '1 kg streaky bacon + 1 kg back bacon', expect: [['bacon', '1kg'], ['bacon', '1kg', { Type: 'Back' }]] },
  { name: 'Hlengiwe Ngcobo', text: '3 x 1kg mince', expect: [['beef_mince', '3x1000g']] },
  { name: 'Izak Marais', text: '2 ribeyes, 2 rumps, 2 sirloins', expect: [['beef_ribeye', 2], ['beef_rump', 2], ['beef_sirloin', 2]] },
  { name: 'Johanna Muller', text: '1kg biltong', expect: null },
  { name: 'Kagiso Tau', text: 'wors 1,5kg', expect: [['boerewors', '1.5kg']] },
  { name: 'Lebo Mokoena', text: '4 pork chops thin cut', expect: [['pork_chops', 4, { Thickness: 'Thin cut' }]] },
  { name: 'Mpho Radebe', text: 'whole chicken portioned x2', expect: [['chicken_whole', 2, { Cut: 'Portioned' }]] },
  { name: 'Nadia Olivier', text: '2kg marrow bones', expect: [['soup_bones', '2kg']] },
  { name: 'Obakeng Sello', text: '1 whole fillet', expect: [['beef_fillet', 1, { Cut: 'Whole' }]] },
  { name: 'Precious Mabaso', text: '3kg chiken breasts', expect: [['chicken_breast', '3kg']] },
  { name: 'Riaan Wessels', text: '4 rump steeks', expect: [['beef_rump', 4]] },
  { name: 'Sanele Zungu', text: '2kg boerwors', expect: [['boerewors', '2kg']] },
  { name: 'Thabo Ndaba', text: '10 lamb chops\n2 packs of 500g mince', expect: [['lamb_chops', 10], ['beef_mince', '2x500g']] },
  { name: 'Uys Vermeulen', text: '15 fillets', expect: null },
  { name: 'Vanessa Jacobs', text: '1 leg of lamb butterflied\n1kg lamb neck\nDeliver to 3 Kerk Street, Parys', expect: [['lamb_leg', 1, { Bone: 'Butterflied' }], ['lamb_neck', '1kg']], fulfilment: 'delivery' },
  { name: 'Werner Steyn', text: '6 T-bone steaks\n2kg wors', expect: [['beef_tbone', 6], ['boerewors', '2kg']] },
  { name: 'Xander Louw', text: '2kg pork sausages, 1kg boerewors', expect: [['pork_sausages', '2kg'], ['boerewors', '1kg']] },
  { name: 'Yvonne Ferreira', text: 'Can I have 2 cowboy steaks and 1kg mince', expect: null },
];

/** Follow-up messages later in the same chat: amendments, additions, chatter, a question, a double paste. */
export const FOLLOW_UPS: { name: string; text: string }[] = [
  { name: 'Anna Venter', text: 'Actually make the mince 3kg' },
  { name: 'Ben Coetzee', text: 'Thanks!' },
  { name: 'Terram Farm', text: 'Sure David, noted 👍' },
  { name: 'David Nel', text: 'sorry, make that 3 ribeyes' },
  { name: 'Carla Joubert', text: 'What time do you close on Friday?' },
  { name: 'Frans Meyer', text: 'also 1kg bacon' },
  { name: 'Gugu Ndlovu', text: 'make those 2' },
  { name: 'Jaco Smit', text: 'please add 2kg wors' },
  { name: 'Uys Vermeulen', text: '6 x 500g fillets' },
  { name: 'Werner Steyn', text: '6 T-bone steaks\n2kg wors' },
  { name: 'Lindi Zulu', text: '👍' },
];

export function buildChat(today: string): string {
  const [y, m, d] = today.split('-');
  const exportDate = `${d}/${m}/${y}`;
  const blocks: string[] = [];
  ORDERS.forEach((o, i) => {
    // Every 7th order arrives as a WhatsApp "Export chat" line, the rest as pasted blocks
    if (i % 7 === 3) {
      const lines = o.text.split('\n');
      blocks.push(`[${exportDate}, 08:${String(10 + i).padStart(2, '0')}:00] ${o.name}: ${lines[0]}${lines.length > 1 ? '\n' + lines.slice(1).join('\n') : ''}`);
    } else if (i % 5 === 0) blocks.push(`${o.name}: ${o.text.replace(/\n/g, ', ')}`);
    else blocks.push(`${o.name}:\n${o.text}`);
  });
  for (const f of FOLLOW_UPS) blocks.push(f.name === 'Werner Steyn' ? `${f.name}:\n${f.text}` : `${f.name}: ${f.text}`);
  return blocks.join('\n\n');
}
