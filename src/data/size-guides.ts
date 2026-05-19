export interface SizeChart {
  [size: string]: {
    tour_de_dos?: string;
    tour_de_poitrine?: string;
    tour_de_taille?: string;
    tour_de_hanches?: string;
  };
}

export interface SizeGuideData {
  product_type: string;
  how_to_measure: Record<string, string>;
  size_chart: SizeChart;
  conversions?: Record<string, Record<string, string>>;
  brand_notes?: string;
}

const guides: Record<string, SizeGuideData> = {
  "soutien-gorge": {
    product_type: "soutien-gorge",
    how_to_measure: {
      tour_de_dos: "Mesurer horizontalement juste en dessous de la poitrine",
      tour_de_poitrine: "Mesurer au niveau du point le plus fort de la poitrine",
    },
    size_chart: {
      "75A": { tour_de_dos: "68-72 cm", tour_de_poitrine: "78-80 cm" },
      "75B": { tour_de_dos: "68-72 cm", tour_de_poitrine: "80-83 cm" },
      "75C": { tour_de_dos: "68-72 cm", tour_de_poitrine: "83-86 cm" },
      "80A": { tour_de_dos: "73-77 cm", tour_de_poitrine: "83-85 cm" },
      "80B": { tour_de_dos: "73-77 cm", tour_de_poitrine: "85-88 cm" },
      "80C": { tour_de_dos: "73-77 cm", tour_de_poitrine: "88-91 cm" },
      "80D": { tour_de_dos: "73-77 cm", tour_de_poitrine: "91-94 cm" },
      "85B": { tour_de_dos: "78-82 cm", tour_de_poitrine: "90-93 cm" },
      "85C": { tour_de_dos: "78-82 cm", tour_de_poitrine: "93-96 cm" },
      "85D": { tour_de_dos: "78-82 cm", tour_de_poitrine: "96-99 cm" },
      "90B": { tour_de_dos: "83-87 cm", tour_de_poitrine: "95-98 cm" },
      "90C": { tour_de_dos: "83-87 cm", tour_de_poitrine: "98-101 cm" },
      "90D": { tour_de_dos: "83-87 cm", tour_de_poitrine: "101-104 cm" },
      "95C": { tour_de_dos: "88-92 cm", tour_de_poitrine: "103-106 cm" },
      "95D": { tour_de_dos: "88-92 cm", tour_de_poitrine: "106-109 cm" },
    },
    conversions: {
      "80B": { "FR/EU": "80B", UK: "34B", US: "34B", IT: "2B" },
      "85C": { "FR/EU": "85C", UK: "38C", US: "38C", IT: "3C" },
      "90D": { "FR/EU": "90D", UK: "40D", US: "40D", IT: "4D" },
    },
  },
  culotte: {
    product_type: "culotte",
    how_to_measure: {
      tour_de_taille: "Mesurer à la partie la plus fine du buste",
      tour_de_hanches: "Mesurer à la partie la plus forte des hanches",
    },
    size_chart: {
      XXS: { tour_de_taille: "58-62 cm", tour_de_hanches: "82-86 cm" },
      XS:  { tour_de_taille: "62-66 cm", tour_de_hanches: "86-90 cm" },
      S:   { tour_de_taille: "66-70 cm", tour_de_hanches: "90-94 cm" },
      M:   { tour_de_taille: "70-74 cm", tour_de_hanches: "94-98 cm" },
      L:   { tour_de_taille: "74-80 cm", tour_de_hanches: "98-104 cm" },
      XL:  { tour_de_taille: "80-88 cm", tour_de_hanches: "104-110 cm" },
      XXL: { tour_de_taille: "88-96 cm", tour_de_hanches: "110-116 cm" },
    },
    conversions: {
      XS:  { FR: "36", IT: "40", UK: "8",  US: "4"  },
      S:   { FR: "38", IT: "42", UK: "10", US: "6"  },
      M:   { FR: "40", IT: "44", UK: "12", US: "8"  },
      L:   { FR: "42", IT: "46", UK: "14", US: "10" },
      XL:  { FR: "44", IT: "48", UK: "16", US: "12" },
    },
  },
  body: {
    product_type: "body",
    how_to_measure: {
      tour_de_poitrine: "Mesurer au niveau du point le plus fort de la poitrine",
      tour_de_taille: "Mesurer à la partie la plus fine du buste",
      tour_de_hanches: "Mesurer à la partie la plus forte des hanches",
    },
    size_chart: {
      XS: { tour_de_poitrine: "80-84 cm", tour_de_taille: "62-66 cm", tour_de_hanches: "86-90 cm" },
      S:  { tour_de_poitrine: "84-88 cm", tour_de_taille: "66-70 cm", tour_de_hanches: "90-94 cm" },
      M:  { tour_de_poitrine: "88-92 cm", tour_de_taille: "70-74 cm", tour_de_hanches: "94-98 cm" },
      L:  { tour_de_poitrine: "92-96 cm", tour_de_taille: "74-80 cm", tour_de_hanches: "98-104 cm" },
      XL: { tour_de_poitrine: "96-102 cm", tour_de_taille: "80-88 cm", tour_de_hanches: "104-110 cm" },
    },
  },
};

export function getSizeGuide(productType: string): SizeGuideData | null {
  const key = productType.toLowerCase();
  return guides[key] ?? null;
}

export function getAvailableTypes(): string[] {
  return Object.keys(guides);
}
