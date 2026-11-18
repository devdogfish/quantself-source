// Primary colour: one hex saved in this browser and applied as --brand (the brand palette derives from it).
export const DEFAULT_BRAND = "#005daa";
export const BRAND_KEY = "quantself.brand";
const HEX = /^#[0-9a-f]{6}$/i;

export function applyBrand(hex: string) {
  document.documentElement.style.setProperty("--brand", hex);
  try {
    if (hex === DEFAULT_BRAND) localStorage.removeItem(BRAND_KEY);
    else localStorage.setItem(BRAND_KEY, hex);
  } catch {
    /* storage unavailable */
  }
}

export function savedBrand() {
  try {
    const v = localStorage.getItem(BRAND_KEY);
    return v && HEX.test(v) ? v : DEFAULT_BRAND;
  } catch {
    return DEFAULT_BRAND;
  }
}

// Runs before first paint (inline script in the root layout) to avoid a colour flash.
export const BRAND_BOOT_SCRIPT = `try{var b=localStorage.getItem(${JSON.stringify(BRAND_KEY)});if(b&&/^#[0-9a-f]{6}$/i.test(b))document.documentElement.style.setProperty("--brand",b)}catch(e){}`;
