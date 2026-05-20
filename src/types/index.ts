export interface ProductSearchInput {
  type: string | string[];
  size?: string | string[];
  gender?: "female" | "male";
  brand?: string | string[];
  color?: string | string[];
  max_price?: number;
  min_price?: number;
  sub_type?: string | string[];
}

export interface SizeGuideInput {
  product_type: string;
  brand?: string;
}

export interface StorePoliciesInput {
  topic: string;
}

export interface ProductResult {
  id: string;
  name: string;
  brand: string | null;
  type: string | null;
  sub_type: string | null;
  price: number | null;
  old_price: number | null;
  has_discount: boolean;
  discount_percentage: number;
  sizes_available: string[];
  colors_available: string[];
  url: string | null;
  image_url: string | null;
  description: string | null;
}

export interface ProductSearchResponse {
  products: ProductResult[];
  total: number;
  filters_applied: ProductSearchInput;
  suggestion?: string;
}
