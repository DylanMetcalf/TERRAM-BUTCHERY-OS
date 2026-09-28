/**
 * Terram Farm's product dictionary, from the Beef and Lamb price lists
 * (June 2026) and the online order form. All meat is priced per kg.
 *
 * Administrators manage products from the Products screen after the first
 * run; prices are updated with Products → Update prices.
 *
 * Words that could mean more than one product ("mince", "biltong", "chops",
 * "ribs", "shoulder") are deliberately NOT aliases, so the app asks which one
 * instead of guessing. The learning loop suggests an alias once staff keep
 * choosing the same answer.
 */
export type Prep = [name: string, keywords: string[], isDefault?: boolean];
export interface SeedProduct {
  slug: string;
  name: string;
  customer_name?: string;
  category: string;
  description?: string;
  quantity_type: 'weight' | 'count' | 'either';
  allows_portions?: boolean;
  piece_noun?: string;
  typical_piece_g?: number;
  price_cents?: number;
  price_unit?: 'kg' | 'each';
  aliases: string[];
  preps?: Record<string, Prep[]>;
  customer_visible?: boolean;
  internal_notes?: string;
}

const THICKNESS: Prep[] = [
  ['Standard', [], true],
  ['Thick cut', ['thick', 'thick cut', 'nice and thick', 'extra thick', '3cm', '4cm']],
  ['Thin cut', ['thin', 'thin cut', 'thinly sliced', 'thinly']],
];
const PACKING: Prep[] = [
  ['Standard pack', [], true],
  ['Vacuum packed', ['vacuum', 'vacuum packed', 'vacuum pack', 'vac pack', 'vac packed', 'sealed']],
  ['Individually packed', ['individually', 'individually packed', 'each separately', 'separately', 'pack separately']],
];
/** Only Rump, Sirloin, T-Bone and Rib-Eye can be dry-aged (order form terms). */
const AGEING: Prep[] = [
  ['Normal', [], true],
  ['Dry-aged', ['dry aged', 'dry age', 'dryaged', 'dry ageing', 'dry aging', 'aged']],
];
const DRY_AGED_NOTE = 'Dry-aged on request: up to 30 days, +25%, confirmed by the farm first.';
const STEAK = { Thickness: THICKNESS, Packing: PACKING };
const DRY_AGE_STEAK = { Ageing: AGEING, Thickness: THICKNESS, Packing: PACKING };

const kg = (rand: number) => Math.round(rand * 100);

export const CATALOGUE: SeedProduct[] = [
  // ── Beef – Steaks ───────────────────────────────────────
  {
    slug: 'beef_fillet', name: 'Fillet', category: 'Beef – Steaks', quantity_type: 'either', allows_portions: true, piece_noun: 'steak', typical_piece_g: 250,
    price_cents: kg(280), price_unit: 'kg', aliases: ['fillet', 'beef fillet', 'filet', 'fillet steak', 'tenderloin', 'beef tenderloin', 'filet mignon'],
    preps: {
      Cut: [['Steaks', ['steak', 'steaks', 'medallion', 'medallions', 'cut into steaks'], true], ['Whole', ['whole', 'whole fillet', 'in one piece', 'uncut']]],
      Packing: PACKING,
    },
  },
  {
    slug: 'beef_fillet_bone', name: 'Fillet on the Bone', category: 'Beef – Steaks', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 400,
    price_cents: kg(270), price_unit: 'kg', aliases: ['fillet on the bone', 'fillet on bone', 'bone in fillet', 'fillet bone in', 'bone-in fillet'], preps: STEAK,
  },
  {
    slug: 'beef_rump', name: 'Rump', category: 'Beef – Steaks', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 300,
    price_cents: kg(185), price_unit: 'kg', description: DRY_AGED_NOTE, aliases: ['rump', 'rump steak', 'beef rump', 'rumpsteak'], preps: DRY_AGE_STEAK,
  },
  {
    slug: 'beef_sirloin', name: 'Sirloin', category: 'Beef – Steaks', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 300,
    price_cents: kg(160), price_unit: 'kg', description: DRY_AGED_NOTE, aliases: ['sirloin', 'sirloin steak', 'beef sirloin', 'striploin', 'strip loin'], preps: DRY_AGE_STEAK,
  },
  {
    slug: 'beef_tbone', name: 'T-Bone', category: 'Beef – Steaks', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 450,
    price_cents: kg(180), price_unit: 'kg', description: DRY_AGED_NOTE, aliases: ['t bone', 't-bone', 'tbone', 't bone steak', 'tee bone'], preps: DRY_AGE_STEAK,
  },
  {
    slug: 'beef_ribeye', name: 'Rib-Eye', category: 'Beef – Steaks', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 350,
    price_cents: kg(240), price_unit: 'kg', description: DRY_AGED_NOTE, aliases: ['ribeye', 'rib eye', 'rib-eye', 'ribeye steak', 'rib eye steak', 'beef ribeye', 'scotch fillet', 'boneless ribeye'], preps: DRY_AGE_STEAK,
  },
  {
    slug: 'beef_ribeye_bone', name: 'Rib-Eye on the Bone', category: 'Beef – Steaks', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 550,
    price_cents: kg(220), price_unit: 'kg',
    aliases: ['rib eye on the bone', 'ribeye on the bone', 'ribeye on bone', 'ribeye bone in', 'rib eye bone in', 'bone in ribeye', 'bone in rib eye', 'cowboy steak', 'prime rib'],
    preps: STEAK,
  },
  {
    slug: 'beef_tomahawk', name: 'Tomahawk', category: 'Beef – Steaks', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 1200,
    price_cents: kg(220), price_unit: 'kg', aliases: ['tomahawk', 'tomahawk steak', 'tomahawks'], preps: STEAK,
  },
  {
    slug: 'beef_porterhouse', name: 'Porterhouse', category: 'Beef – Steaks', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 600,
    price_cents: kg(180), price_unit: 'kg', aliases: ['porterhouse', 'porterhouse steak', 'porter house'], preps: STEAK,
  },
  // ── Beef – Cuts ─────────────────────────────────────────
  {
    slug: 'beef_chuck_chops', name: 'Chuck Chops', category: 'Beef – Cuts', quantity_type: 'either', allows_portions: true, piece_noun: 'chop', typical_piece_g: 300,
    price_cents: kg(110), price_unit: 'kg', aliases: ['chuck chops', 'chuck chop', 'chuck', 'beef chuck'], preps: STEAK,
  },
  {
    slug: 'beef_short_rib', name: 'Short Rib', category: 'Beef – Cuts', quantity_type: 'weight', allows_portions: true, piece_noun: 'piece',
    price_cents: kg(135), price_unit: 'kg', aliases: ['short rib', 'short ribs', 'beef short rib', 'beef rib', 'beef ribs', 'jacob ladder', 'jacobs ladder'],
    preps: { Packing: PACKING },
  },
  {
    slug: 'beef_minute_steak', name: 'Minute Steak', category: 'Beef – Cuts', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(160), price_unit: 'kg', aliases: ['minute steak', 'minute steaks'], preps: { Packing: PACKING },
  },
  {
    slug: 'beef_shin', name: 'Beef Shin', category: 'Beef – Cuts', quantity_type: 'weight', piece_noun: 'piece',
    price_cents: kg(130), price_unit: 'kg', aliases: ['shin', 'beef shin', 'shin bone', 'osso buco', 'ossobuco'],
    preps: { Cut: [['Sliced', ['sliced', 'osso buco'], true], ['Whole', ['whole']]], Packing: PACKING },
  },
  {
    slug: 'beef_brisket', name: 'Brisket', category: 'Beef – Cuts', quantity_type: 'weight', allows_portions: true, piece_noun: 'piece',
    price_cents: kg(130), price_unit: 'kg', aliases: ['brisket', 'beef brisket'],
    preps: { Cut: [['Whole', ['whole'], true], ['Halved', ['half', 'halved', 'cut in half']], ['Rolled', ['rolled', 'tied']]], Packing: PACKING },
  },
  {
    slug: 'beef_blade_chops', name: 'Blade Chops', category: 'Beef – Cuts', quantity_type: 'either', allows_portions: true, piece_noun: 'chop', typical_piece_g: 300,
    price_cents: kg(130), price_unit: 'kg', aliases: ['blade chops', 'blade chop', 'blade', 'beef blade'], preps: STEAK,
  },
  // ── Beef – Minced ───────────────────────────────────────
  {
    slug: 'beef_mince_lean', name: 'Lean Mince', category: 'Beef – Minced', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(125), price_unit: 'kg', aliases: ['lean mince', 'extra lean mince', 'lean beef mince', 'lean minced beef', 'lean ground beef'], preps: { Packing: PACKING },
  },
  {
    slug: 'beef_mince_8020', name: '80:20 Mince', category: 'Beef – Minced', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(110), price_unit: 'kg', aliases: ['80to20 mince', '80 20 mince', '8020 mince', 'eighty twenty mince', 'normal mince', 'regular mince', 'burger mince'], preps: { Packing: PACKING },
  },
  {
    slug: 'wors_normal', name: 'Normal Wors', customer_name: 'Boerewors', category: 'Beef – Minced', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(120), price_unit: 'kg', aliases: ['normal wors', 'wors', 'boerewors', 'boerie', 'boerwors', 'boere wors', 'boerewor', 'traditional wors', 'farm wors', 'regular wors'],
    preps: { Style: [['Coil', ['coil', 'whole coil'], true], ['Links', ['links', 'cut', 'cut in pieces']]], Packing: PACKING },
  },
  {
    slug: 'wors_bbq', name: 'BBQ Wors', category: 'Beef – Minced', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(100), price_unit: 'kg', aliases: ['bbq wors', 'braai wors', 'barbecue wors', 'bbq boerewors', 'braaiwors'],
    preps: { Style: [['Coil', ['coil', 'whole coil'], true], ['Links', ['links', 'cut', 'cut in pieces']]], Packing: PACKING },
  },
  // ── Beef – Stewing ──────────────────────────────────────
  {
    slug: 'beef_stewing', name: 'Stewing (Bone-In)', category: 'Beef – Stewing', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(100), price_unit: 'kg', aliases: ['stewing bone in', 'stewing', 'stewing beef', 'stew beef', 'beef stew', 'bone in stew', 'stew meat', 'potjie meat', 'beef stewing'],
    preps: { Packing: PACKING },
  },
  {
    slug: 'beef_bones', name: 'Bones', category: 'Beef – Stewing', quantity_type: 'weight', piece_noun: 'bag',
    price_cents: kg(25), price_unit: 'kg', aliases: ['bones', 'soup bones', 'beef bones', 'marrow bones', 'dog bones', 'stock bones'],
  },
  {
    slug: 'beef_goulash', name: 'Goulash', category: 'Beef – Stewing', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(135), price_unit: 'kg', aliases: ['goulash', 'beef goulash', 'goulash meat', 'cubed beef', 'beef cubes', 'boneless stew', 'diced beef'],
    preps: { Packing: PACKING },
  },
  // ── Beef – Biltong ──────────────────────────────────────
  {
    slug: 'biltong_a_grade', name: 'A-Grade Biltong', category: 'Beef – Biltong', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(340), price_unit: 'kg', aliases: ['a grade biltong', 'a-grade biltong', 'agrade biltong', 'lean biltong', 'grade a biltong'],
    preps: { Cut: [['Whole sticks', ['sticks', 'whole', 'uncut'], true], ['Sliced', ['sliced', 'cut', 'chipped']]], Packing: PACKING },
  },
  {
    slug: 'biltong_geel_vet', name: 'Geel Vet Biltong', category: 'Beef – Biltong', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(320), price_unit: 'kg', aliases: ['geel vet biltong', 'geelvet biltong', 'geel vet', 'geelvet', 'yellow fat biltong', 'fatty biltong', 'fat biltong'],
    preps: { Cut: [['Whole sticks', ['sticks', 'whole', 'uncut'], true], ['Sliced', ['sliced', 'cut', 'chipped']]], Packing: PACKING },
  },
  {
    slug: 'droewors', name: 'Droewors', category: 'Beef – Biltong', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(340), price_unit: 'kg', aliases: ['droewors', 'droe wors', 'droë wors', 'dry wors', 'dried wors', 'dry sausage'], preps: { Packing: PACKING },
  },
  // ── Beef – Special ──────────────────────────────────────
  {
    slug: 'skilpadjies', name: 'Skilpadjies', category: 'Beef – Special', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(95), price_unit: 'kg', aliases: ['skilpadjies', 'skilpadjie', 'skilpaadjies', 'liver in caul fat'], preps: { Packing: PACKING },
  },
  {
    slug: 'beef_smoked_brisket', name: 'Smoked Brisket (Marinated)', customer_name: 'Smoked Brisket (Marinated)', category: 'Beef – Special', quantity_type: 'weight', allows_portions: true, piece_noun: 'piece',
    price_cents: kg(450), price_unit: 'kg', aliases: ['smoked brisket', 'marinated brisket', 'smoked marinated brisket', 'marinated smoked brisket'], preps: { Packing: PACKING },
  },
  {
    slug: 'beef_brisket_fat', name: 'Brisket Fat', category: 'Beef – Special', quantity_type: 'weight', piece_noun: 'bag',
    price_cents: kg(130), price_unit: 'kg', aliases: ['brisket fat', 'brikset fat'],
  },
  {
    slug: 'beef_body_fat', name: 'Body Fat', category: 'Beef – Special', quantity_type: 'weight', piece_noun: 'bag',
    price_cents: kg(80), price_unit: 'kg', aliases: ['body fat', 'beef fat', 'suet', 'fat', 'tallow fat'],
  },
  // ── Lamb – Full ─────────────────────────────────────────
  {
    slug: 'lamb_whole', name: 'Whole Lamb', category: 'Lamb – Full', quantity_type: 'count', piece_noun: 'lamb', typical_piece_g: 18000,
    price_cents: kg(140), price_unit: 'kg', description: 'Priced per kg of carcass weight. Add cutting instructions in the notes.',
    aliases: ['whole lamb', 'full lamb', 'lamb whole', 'lamb carcass', 'whole lamb carcass'], preps: { Packing: PACKING },
  },
  {
    slug: 'lamb_half', name: 'Half Lamb', category: 'Lamb – Full', quantity_type: 'count', piece_noun: 'half lamb', typical_piece_g: 9000,
    price_cents: kg(145), price_unit: 'kg', description: 'Priced per kg of carcass weight. Add cutting instructions in the notes.',
    aliases: ['half lamb', 'half a lamb', 'lamb half', 'half carcass lamb'], preps: { Packing: PACKING },
  },
  // ── Lamb – Roast ────────────────────────────────────────
  {
    slug: 'lamb_shoulder', name: 'Lamb Shoulder', customer_name: 'Lamb Shoulder (Roast)', category: 'Lamb – Roast', quantity_type: 'either', piece_noun: 'shoulder', typical_piece_g: 2000,
    price_cents: kg(210), price_unit: 'kg', aliases: ['lamb shoulder', 'shoulder of lamb', 'lamb shoulder roast', 'shoulder roast', 'roast shoulder', 'mutton shoulder'],
    preps: { Cut: [['Whole', ['whole'], true], ['Deboned & rolled', ['deboned', 'rolled', 'boneless']]], Packing: PACKING },
  },
  {
    slug: 'lamb_leg', name: 'Leg of Lamb', category: 'Lamb – Roast', quantity_type: 'either', piece_noun: 'leg', typical_piece_g: 2500,
    price_cents: kg(225), price_unit: 'kg', aliases: ['leg of lamb', 'lamb leg', 'leg lamb', 'lamb roast', 'leg of mutton', 'mutton leg', 'leg'],
    preps: {
      Bone: [['Bone-in', ['bone in', 'on the bone', 'with bone', 'bone-in'], true], ['Deboned & rolled', ['deboned', 'boneless', 'rolled', 'bone out', 'deboned and rolled']], ['Butterflied', ['butterfly', 'butterflied', 'butterflyd']]],
      Packing: PACKING,
    },
  },
  // ── Lamb – Chops ────────────────────────────────────────
  {
    slug: 'lamb_loin_chops', name: 'Lamb Loin Chops', category: 'Lamb – Chops', quantity_type: 'either', allows_portions: true, piece_noun: 'chop', typical_piece_g: 120,
    price_cents: kg(265), price_unit: 'kg', aliases: ['lamb loin chops', 'loin chops', 'loin chop', 'lamb chops', 'lamb chop', 'chops lamb', 'mutton chops', 'mutton chop'],
    preps: STEAK,
  },
  {
    slug: 'lamb_rib_chops', name: 'Lamb Rib Chops', category: 'Lamb – Chops', quantity_type: 'either', allows_portions: true, piece_noun: 'chop', typical_piece_g: 90,
    price_cents: kg(260), price_unit: 'kg', aliases: ['lamb rib chops', 'rib chops', 'rib chop', 'lamb cutlets', 'lamb cutlet', 'cutlets'], preps: STEAK,
  },
  {
    slug: 'lamb_shoulder_chops', name: 'Lamb Shoulder Chops', category: 'Lamb – Chops', quantity_type: 'either', allows_portions: true, piece_noun: 'chop', typical_piece_g: 180,
    price_cents: kg(235), price_unit: 'kg', aliases: ['lamb shoulder chops', 'shoulder chops', 'shoulder chop', 'lamb shoulder chop'], preps: STEAK,
  },
  // ── Lamb – Special ──────────────────────────────────────
  {
    slug: 'lamb_shanks', name: 'Lamb Shanks', category: 'Lamb – Special', quantity_type: 'either', piece_noun: 'shank', typical_piece_g: 450,
    price_cents: kg(240), price_unit: 'kg', aliases: ['lamb shank', 'lamb shanks', 'shank', 'shanks', 'mutton shank'], preps: { Packing: PACKING },
  },
  {
    slug: 'lamb_ribs', name: 'Lamb Ribs', category: 'Lamb – Special', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(230), price_unit: 'kg', aliases: ['lamb ribs', 'lamb rib', 'lamb riblets', 'riblets', 'mutton ribs', 'lamb breast'], preps: { Packing: PACKING },
  },
  {
    slug: 'lamb_tails', name: 'Lamb Tails', category: 'Lamb – Special', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(200), price_unit: 'kg', aliases: ['lamb tails', 'lamb tail', 'tails', 'sheep tails', 'sheep tail', 'mutton tails'], preps: { Packing: PACKING },
  },
  // ── Lamb – Stewing ──────────────────────────────────────
  {
    slug: 'lamb_stew', name: 'Lamb Stew', category: 'Lamb – Stewing', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: kg(175), price_unit: 'kg', aliases: ['lamb stew', 'lamb stewing', 'stewing lamb', 'mutton stew', 'lamb potjie', 'potjie lamb', 'lamb neck', 'neck slices'],
    preps: { Packing: PACKING },
  },
  // ── Lamb – Sheep ────────────────────────────────────────
  {
    slug: 'sheep_whole', name: 'Whole Sheep', category: 'Lamb – Sheep', quantity_type: 'count', piece_noun: 'sheep', typical_piece_g: 25000,
    price_cents: kg(135), price_unit: 'kg', description: 'Priced per kg of carcass weight. Add cutting instructions in the notes.',
    aliases: ['whole sheep', 'sheep', 'full sheep', 'whole mutton', 'mutton carcass', 'sheep carcass'], preps: { Packing: PACKING },
  },
  // ── Eggs ────────────────────────────────────────────────
  {
    // Retail price per egg. "A tray" is read as 30 eggs, "a dozen" as 12.
    slug: 'eggs', name: 'Eggs', category: 'Eggs', quantity_type: 'count', piece_noun: 'egg',
    price_cents: 250, price_unit: 'each', description: 'R2.50 per egg. A tray is 30 eggs.',
    internal_notes: 'Retail R2.50/egg. Wholesale (R2/egg) is handled outside the app.',
    aliases: ['eggs', 'egg', 'farm eggs', 'free range eggs', 'tray of eggs', 'egg tray', 'trays of eggs'],
  },
];
