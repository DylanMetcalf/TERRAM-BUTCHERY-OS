/**
 * The generic starter dictionary the parsing, pipeline and acceptance tests
 * were written against (beef, lamb, pork, chicken, overlapping vocabulary).
 * The app itself seeds Terram's real price list from server/seed/catalogue.ts.
 */
import type { Prep, SeedProduct } from '../../server/seed/catalogue';

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
const BONE_STEAK: Prep[] = [
  ['Boneless', ['boneless', 'bone out', 'off the bone', 'deboned', 'no bone', 'without bone', 'off bone'], true],
  ['Bone-in', ['bone in', 'bone-in', 'on the bone', 'on bone', 'with bone', 'with the bone', 'bone on']],
];

export const TEST_CATALOGUE: SeedProduct[] = [
  // ── Beef ────────────────────────────────────────────────
  {
    slug: 'beef_mince', name: 'Beef Mince', category: 'Beef', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: 14500, price_unit: 'kg', description: 'Grass-fed beef, minced in-house.',
    aliases: ['mince', 'beef mince', 'minced beef', 'mincemeat', 'mince meat', 'ground beef', 'minced meat'],
    preps: { Fat: [['Standard', [], true], ['Lean', ['lean', 'extra lean', 'low fat', 'lean mince']]], Packing: PACKING },
  },
  {
    slug: 'beef_rump', name: 'Rump Steak', category: 'Beef', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 300,
    price_cents: 26500, price_unit: 'kg', aliases: ['rump', 'rump steak', 'beef rump', 'rumpsteak'],
    preps: { Thickness: THICKNESS, Packing: PACKING },
  },
  {
    slug: 'beef_sirloin', name: 'Sirloin Steak', category: 'Beef', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 300,
    price_cents: 25500, price_unit: 'kg', aliases: ['sirloin', 'sirloin steak', 'beef sirloin', 'porterhouse', 'strip loin', 'striploin'],
    preps: { Thickness: THICKNESS, Packing: PACKING },
  },
  {
    slug: 'beef_ribeye', name: 'Beef Ribeye', customer_name: 'Ribeye Steak', category: 'Beef', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 350,
    price_cents: 31000, price_unit: 'kg', aliases: ['ribeye', 'rib eye', 'rib-eye', 'ribeye steak', 'rib eye steak', 'beef ribeye', 'scotch fillet'],
    preps: { Bone: BONE_STEAK, Thickness: THICKNESS, Packing: PACKING },
  },
  {
    slug: 'beef_fillet', name: 'Beef Fillet', category: 'Beef', quantity_type: 'either', allows_portions: true, piece_noun: 'piece', typical_piece_g: 250,
    price_cents: 42000, price_unit: 'kg', aliases: ['fillet', 'beef fillet', 'filet', 'fillet steak', 'tenderloin', 'beef tenderloin', 'filet mignon'],
    preps: {
      Cut: [['Steaks', ['steak', 'steaks', 'medallion', 'medallions', 'cut into steaks'], true], ['Whole', ['whole', 'whole fillet', 'in one piece', 'uncut']], ['Portions', ['portion', 'portions', 'portioned']]],
      Packing: PACKING,
    },
  },
  {
    slug: 'beef_tbone', name: 'T-Bone Steak', category: 'Beef', quantity_type: 'either', piece_noun: 'steak', typical_piece_g: 450,
    price_cents: 23500, price_unit: 'kg', aliases: ['t bone', 't-bone', 'tbone', 't bone steak', 'tee bone'],
    preps: { Thickness: THICKNESS, Packing: PACKING },
  },
  {
    slug: 'beef_brisket', name: 'Beef Brisket', category: 'Beef', quantity_type: 'weight', allows_portions: true, piece_noun: 'piece',
    price_cents: 15500, price_unit: 'kg', aliases: ['brisket', 'beef brisket'],
    preps: { Cut: [['Whole', ['whole'], true], ['Halved', ['half', 'halved', 'cut in half']], ['Rolled', ['rolled', 'tied']]], Packing: PACKING },
  },
  {
    slug: 'beef_short_rib', name: 'Beef Short Rib', category: 'Beef', quantity_type: 'weight', allows_portions: true, piece_noun: 'piece',
    price_cents: 17500, price_unit: 'kg', aliases: ['short rib', 'short ribs', 'beef short rib', 'beef rib', 'beef ribs', 'jacob ladder', 'jacobs ladder'],
    preps: { Cut: [['Standard', [], true], ['English cut', ['english cut', 'individual ribs']], ['Flanken', ['flanken', 'across the bone', 'korean style']]], Packing: PACKING },
  },
  {
    slug: 'beef_stewing', name: 'Stewing Beef', category: 'Beef', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: 15500, price_unit: 'kg', aliases: ['stewing beef', 'stew beef', 'beef stew', 'goulash', 'stew meat', 'beef cubes', 'cubed beef', 'chuck', 'stewing steak', 'potjie meat'],
    preps: { Cut: [['Cubed', ['cubed', 'cubes', 'diced'], true], ['Strips', ['strips', 'stir fry', 'stirfry', 'sliced']]], Packing: PACKING },
  },
  {
    slug: 'beef_topside', name: 'Topside Roast', category: 'Beef', quantity_type: 'weight', piece_noun: 'roast',
    price_cents: 21000, price_unit: 'kg', aliases: ['topside', 'topside roast', 'beef roast', 'roast beef', 'silverside', 'rolled roast'],
    preps: { Cut: [['Roast', ['roast', 'whole', 'rolled', 'tied'], true], ['Sliced', ['sliced', 'carpaccio']]], Packing: PACKING },
  },
  {
    slug: 'beef_oxtail', name: 'Oxtail', category: 'Beef', quantity_type: 'weight', piece_noun: 'pack',
    price_cents: 27000, price_unit: 'kg', aliases: ['oxtail', 'ox tail', 'beef tail'],
    preps: { Packing: PACKING },
  },
  {
    slug: 'beef_shin', name: 'Beef Shin', category: 'Beef', quantity_type: 'weight', piece_noun: 'piece',
    price_cents: 15000, price_unit: 'kg', aliases: ['shin', 'beef shin', 'shin bone', 'osso buco', 'ossobuco'],
    preps: { Cut: [['Sliced', ['sliced', 'osso buco'], true], ['Whole', ['whole']]], Packing: PACKING },
  },
  {
    slug: 'beef_burger', name: 'Beef Burger Patties', category: 'Beef', quantity_type: 'count', piece_noun: 'patty', typical_piece_g: 150,
    price_cents: 2800, price_unit: 'each', aliases: ['burger', 'burger patty', 'burger patties', 'patty', 'patties', 'beef burger', 'beef patty', 'burgers'],
    preps: { Size: [['150g', ['150g', 'regular'], true], ['200g', ['200g', 'large', 'big']]], Packing: PACKING },
  },
  // ── Sausage ─────────────────────────────────────────────
  {
    slug: 'boerewors', name: 'Boerewors', category: 'Sausages', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: 15500, price_unit: 'kg', description: 'Traditional farm recipe, coriander-spiced.',
    aliases: ['boerewors', 'wors', 'boerie', 'boerwors', 'boere wors', 'farm sausage', 'farm wors', 'traditional wors', 'boerewor'],
    preps: { Style: [['Coil', ['coil', 'whole coil'], true], ['Links', ['links', 'cut', 'cut in pieces']]], Packing: PACKING },
  },
  {
    slug: 'pork_sausages', name: 'Pork Sausages', category: 'Sausages', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: 13500, price_unit: 'kg', aliases: ['pork sausage', 'pork bangers', 'banger', 'bangers', 'breakfast sausage', 'sausage', 'sausages'],
    preps: { Packing: PACKING },
  },
  // ── Lamb ────────────────────────────────────────────────
  {
    slug: 'lamb_chops', name: 'Lamb Loin Chops', customer_name: 'Lamb Chops', category: 'Lamb', quantity_type: 'either', allows_portions: true, piece_noun: 'chop', typical_piece_g: 120,
    price_cents: 29500, price_unit: 'kg', aliases: ['lamb chop', 'lamb chops', 'loin chop', 'loin chops', 'lamb loin chop', 'chops lamb', 'mutton chop', 'mutton chops'],
    preps: { Thickness: THICKNESS, Packing: PACKING },
  },
  {
    slug: 'lamb_leg', name: 'Leg of Lamb', category: 'Lamb', quantity_type: 'either', piece_noun: 'leg', typical_piece_g: 2500,
    price_cents: 26500, price_unit: 'kg', aliases: ['leg of lamb', 'lamb leg', 'leg lamb', 'lamb roast', 'leg of mutton', 'mutton leg'],
    preps: {
      Bone: [['Bone-in', ['bone in', 'on the bone', 'with bone', 'bone-in'], true], ['Deboned & rolled', ['deboned', 'boneless', 'rolled', 'bone out', 'deboned and rolled']], ['Butterflied', ['butterfly', 'butterflied', 'butterflyd']]],
      Packing: PACKING,
    },
  },
  {
    slug: 'lamb_shoulder', name: 'Lamb Shoulder', category: 'Lamb', quantity_type: 'either', piece_noun: 'shoulder', typical_piece_g: 2000,
    price_cents: 23500, price_unit: 'kg', aliases: ['lamb shoulder', 'shoulder of lamb', 'mutton shoulder'],
    preps: { Cut: [['Whole', ['whole'], true], ['Cubed', ['cubed', 'diced', 'potjie', 'stew']], ['Deboned & rolled', ['deboned', 'rolled', 'boneless']]], Packing: PACKING },
  },
  {
    slug: 'lamb_rack', name: 'Rack of Lamb', category: 'Lamb', quantity_type: 'count', piece_noun: 'rack', typical_piece_g: 700,
    price_cents: 32000, price_unit: 'kg', aliases: ['rack of lamb', 'lamb rack', 'lamb cutlet', 'lamb cutlets', 'french rack'],
    preps: { Trim: [['Frenched', ['frenched', 'french trimmed'], true], ['Untrimmed', ['untrimmed', 'not frenched']]], Packing: PACKING },
  },
  {
    slug: 'lamb_shank', name: 'Lamb Shank', category: 'Lamb', quantity_type: 'count', piece_noun: 'shank', typical_piece_g: 450,
    price_cents: 22500, price_unit: 'kg', aliases: ['lamb shank', 'lamb shanks', 'shank', 'shanks'],
    preps: { Packing: PACKING },
  },
  {
    slug: 'lamb_neck', name: 'Lamb Neck', category: 'Lamb', quantity_type: 'weight', piece_noun: 'pack',
    price_cents: 19500, price_unit: 'kg', aliases: ['lamb neck', 'neck of lamb', 'mutton neck', 'neck slices', 'lamb neck slices'],
    preps: { Packing: PACKING },
  },
  // ── Pork ────────────────────────────────────────────────
  {
    slug: 'pork_chops', name: 'Pork Chops', category: 'Pork', quantity_type: 'either', allows_portions: true, piece_noun: 'chop', typical_piece_g: 220,
    price_cents: 14500, price_unit: 'kg', aliases: ['pork chop', 'pork chops', 'pork loin chop'],
    preps: { Bone: [['Bone-in', ['bone in', 'on the bone'], true], ['Boneless', ['boneless', 'deboned', 'off the bone']]], Thickness: THICKNESS, Packing: PACKING },
  },
  {
    slug: 'pork_belly', name: 'Pork Belly', category: 'Pork', quantity_type: 'weight', allows_portions: true, piece_noun: 'piece',
    price_cents: 15500, price_unit: 'kg', aliases: ['pork belly', 'belly pork', 'belly'],
    preps: {
      Skin: [['Skin on, scored', ['skin on', 'scored', 'with skin', 'crackling'], true], ['Skin off', ['skin off', 'no skin', 'skinless', 'without skin']]],
      Bone: [['Boneless', ['boneless', 'deboned'], true], ['Bone-in', ['bone in', 'on the bone']]],
      Packing: PACKING,
    },
  },
  {
    slug: 'pork_loin', name: 'Pork Loin Roast', category: 'Pork', quantity_type: 'weight', piece_noun: 'roast',
    price_cents: 15500, price_unit: 'kg', aliases: ['pork loin', 'pork roast', 'loin of pork', 'pork loin roast'],
    preps: { Cut: [['Rolled roast', ['rolled', 'roast', 'tied'], true], ['Bone-in', ['bone in', 'on the bone']]], Packing: PACKING },
  },
  {
    slug: 'pork_ribs', name: 'Pork Spare Ribs', category: 'Pork', quantity_type: 'weight', allows_portions: true, piece_noun: 'rack',
    price_cents: 17500, price_unit: 'kg', aliases: ['pork rib', 'pork ribs', 'spare rib', 'spare ribs', 'spareribs', 'sticky ribs', 'ribs'],
    preps: { Style: [['Plain', ['plain', 'unmarinated', 'no sauce'], true], ['Basted', ['basted', 'marinated', 'sticky', 'bbq', 'barbecue']]], Packing: PACKING },
  },
  {
    slug: 'bacon', name: 'Bacon', category: 'Pork', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: 21000, price_unit: 'kg', aliases: ['bacon', 'streaky bacon', 'back bacon', 'rasher', 'rashers', 'smoked bacon'],
    preps: { Type: [['Streaky', ['streaky'], true], ['Back', ['back', 'short back', 'middle']]], Packing: PACKING },
  },
  {
    slug: 'gammon', name: 'Gammon', category: 'Pork', quantity_type: 'weight', piece_noun: 'piece',
    price_cents: 16500, price_unit: 'kg', aliases: ['gammon', 'gammon joint', 'ham', 'christmas ham', 'gammon roast'],
    preps: { Bone: [['Boneless', ['boneless', 'deboned'], true], ['Bone-in', ['bone in', 'on the bone']]], Packing: PACKING },
  },
  // ── Chicken ─────────────────────────────────────────────
  {
    slug: 'chicken_whole', name: 'Whole Chicken', category: 'Chicken', quantity_type: 'count', piece_noun: 'chicken', typical_piece_g: 1800,
    price_cents: 8900, price_unit: 'kg', description: 'Free-range, pasture-raised.',
    aliases: ['whole chicken', 'chicken', 'whole bird', 'roast chicken', 'full chicken', 'free range chicken'],
    preps: { Cut: [['Whole', ['whole'], true], ['Portioned', ['portioned', 'cut up', 'braai pack', '8 pieces', 'pieces', 'jointed']], ['Spatchcocked', ['spatchcock', 'spatchcocked', 'flattened', 'butterflied', 'flatty']]], Packing: PACKING },
  },
  {
    slug: 'chicken_breast', name: 'Chicken Breast Fillets', category: 'Chicken', quantity_type: 'either', allows_portions: true, piece_noun: 'fillet', typical_piece_g: 200,
    price_cents: 12500, price_unit: 'kg', aliases: ['chicken breast', 'chicken breasts', 'chicken breast fillet', 'breast fillet', 'breast fillets', 'chicken breast fillets'],
    preps: { Skin: [['Skinless', ['skinless', 'skin off', 'no skin'], true], ['Skin on', ['skin on', 'with skin']]], Packing: PACKING },
  },
  {
    slug: 'chicken_thighs', name: 'Chicken Thighs', category: 'Chicken', quantity_type: 'either', allows_portions: true, piece_noun: 'thigh', typical_piece_g: 150,
    price_cents: 9500, price_unit: 'kg', aliases: ['chicken thigh', 'chicken thighs', 'thigh', 'thighs'],
    preps: { Bone: [['Bone-in', ['bone in', 'on the bone', 'with bone'], true], ['Boneless', ['boneless', 'deboned', 'thigh fillet', 'fillets']]], Skin: [['Skin on', ['skin on', 'with skin'], true], ['Skinless', ['skinless', 'skin off', 'no skin']]], Packing: PACKING },
  },
  {
    slug: 'chicken_drumsticks', name: 'Chicken Drumsticks', category: 'Chicken', quantity_type: 'either', allows_portions: true, piece_noun: 'drumstick', typical_piece_g: 120,
    price_cents: 8500, price_unit: 'kg', aliases: ['drumstick', 'drumsticks', 'chicken drumstick', 'chicken drumsticks', 'chicken legs', 'drummies'],
    preps: { Packing: PACKING },
  },
  {
    slug: 'chicken_wings', name: 'Chicken Wings', category: 'Chicken', quantity_type: 'weight', allows_portions: true, piece_noun: 'pack',
    price_cents: 8900, price_unit: 'kg', aliases: ['chicken wing', 'chicken wings', 'wings', 'wing'],
    preps: { Cut: [['Whole', ['whole'], true], ['Split', ['split', 'jointed', 'cut']]], Packing: PACKING },
  },
  // ── Other ───────────────────────────────────────────────
  {
    slug: 'soup_bones', name: 'Soup Bones', category: 'Other', quantity_type: 'weight', piece_noun: 'bag',
    price_cents: 4500, price_unit: 'kg', aliases: ['soup bone', 'soup bones', 'bones', 'marrow bones', 'marrow bone', 'dog bones', 'stock bones'],
    preps: { Packing: PACKING },
  },
  {
    slug: 'beef_fat', name: 'Beef Fat (Suet)', category: 'Other', quantity_type: 'weight', piece_noun: 'bag', customer_visible: false,
    price_cents: 3000, price_unit: 'kg', aliases: ['beef fat', 'suet', 'fat', 'tallow fat'],
  },
];
