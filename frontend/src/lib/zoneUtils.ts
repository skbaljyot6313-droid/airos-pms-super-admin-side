import {
  Refrigerator,
  CookingPot,
  Flame,
  Blend,
  Microwave,
  Coffee,
  WashingMachine,
  Droplets,
  AirVent,
  Tv,
  Monitor,
  Dumbbell,
  UtensilsCrossed,
  Wine,
  Armchair,
  Printer,
  Video,
  Zap,
  ShowerHead,
  Leaf,
  Car,
  Package,
  LucideIcon,
} from 'lucide-react';
import { Zone, ZoneType } from '../types';

export const ZONE_TYPE_OPTIONS: { value: ZoneType; label: string; hint: string }[] = [
  { value: 'stay', label: 'Guest Stay', hint: 'Rooms, dorms & beds' },
  { value: 'common', label: 'Common Area', hint: 'Lobby, lounge, co-working' },
  { value: 'dining', label: 'Dining / F&B', hint: 'Café, kitchen, restaurant' },
  { value: 'amenities', label: 'Amenities', hint: 'Gym, pool, spa, yoga deck' },
  { value: 'outdoor', label: 'Outdoor', hint: 'Garden, terrace, parking' },
  { value: 'back_of_house', label: 'Back of House', hint: 'Staff, storage, laundry' },
];

export const ZONE_TYPE_LABELS: Record<ZoneType, string> = ZONE_TYPE_OPTIONS.reduce(
  (acc, o) => ({ ...acc, [o.value]: o.label }),
  {} as Record<ZoneType, string>
);

/** Whether a zone can contain rooms/dorms/beds. Missing type = legacy stay zone. */
export const zoneSupportsUnits = (zone?: Pick<Zone, 'zone_type'> | null): boolean =>
  !zone?.zone_type || zone.zone_type === 'stay';

/** Snake-case slug for storing custom zone types (e.g. "Sushi Bar" -> "sushi_bar"). */
export const slugifyZoneType = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Display label — known types map to their curated label, custom ones are prettified. */
export const zoneTypeLabel = (zone?: Pick<Zone, 'zone_type'> | null): string => {
  const t = zone?.zone_type || 'stay';
  return (
    (ZONE_TYPE_LABELS as Record<string, string>)[t] ??
    t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
};

/** Normalize a stored custom-unit entry (string or {name,qty}) to an object. */
export const normalizeZoneUnits = (
  units?: ({ name: string; qty?: number } | string)[] | null
): { name: string; qty: number }[] =>
  (units || [])
    .map((u) => (typeof u === 'string' ? { name: u, qty: 1 } : { name: u.name, qty: u.qty ?? 1 }))
    .filter((u) => u.name);

// Keyword → icon for zone unit rows — first match wins, Package is the fallback.
const UNIT_ICON_MAP: [RegExp, LucideIcon][] = [
  [/freez|chill|fridge|refriger|cold room|ice.?box|ice machine/i, Refrigerator],
  [/tandoor|oven|stove|grill|burner|hob|range|tawa|griddle|kneader|hot case|bain/i, CookingPot],
  [/fry|flame|tandoori|fire/i, Flame],
  [/mix|grind|blend|juicer|processor|knead/i, Blend],
  [/microwave|toaster/i, Microwave],
  [/coffee|espresso|tea|kettle|boiler/i, Coffee],
  [/wash|laundr|dryer|iron/i, WashingMachine],
  [/shower/i, ShowerHead],
  [/sink|dish|water|tap/i, Droplets],
  [/ac\b|air.?con|hvac|vent|exhaust|hood|fan|cool/i, AirVent],
  [/tv\b|television|screen|display/i, Tv],
  [/computer|pos\b|terminal|server|monitor|laptop/i, Monitor],
  [/printer/i, Printer],
  [/gym|treadmill|bench|weight|fitness|yoga/i, Dumbbell],
  [/counter|table|station|desk|prep|cutting/i, UtensilsCrossed],
  [/bar\b|wine|beer|liquor|glass/i, Wine],
  [/sofa|chair|lounger|armchair|seat|furniture|bed\b/i, Armchair],
  [/cctv|camera|security/i, Video],
  [/generat|inverter|ups|electrical|panel|motor|pump|lift|elevator/i, Zap],
  [/plant|garden|pool|outdoor/i, Leaf],
  [/park|vehicle|car\b|van\b/i, Car],
];

export const unitIcon = (name: string): LucideIcon => {
  for (const [re, icon] of UNIT_ICON_MAP) {
    if (re.test(name)) return icon;
  }
  return Package;
};
