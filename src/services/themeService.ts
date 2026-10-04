/**
 * THEME ENGINE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Six themes, all derived from the product logo: a deep navy shell (#001020)
 * and an azure ramp (#0070F2 → #00C0FF). The accent is SAP Fiori 3 Blue
 * 700, which is why it is not green — green read as a "success" state on
 * neutral buttons and the brand became indistinguishable from a status light.
 *
 * The class bundles below are retained for any surface that has not yet been
 * moved onto the design tokens. `themeInspector.ts` measures the REAL cascade,
 * which is what the theme lab reports on — the constants here are labels, not
 * the source of truth.
 */

export type ThemeMode = 'dark' | 'light' | 'oled' | 'royal_gold' | 'high_contrast' | 'frosted_glass';

export interface ThemeConfig {
  id: ThemeMode;
  name: string;
  description: string;
  bgClass: string;
  cardBgClass: string;
  textPrimaryClass: string;
  accentClass: string;
  borderClass: string;
  /** The canvas colour, shown in the swatch. Mirrors `--t-canvas` exactly. */
  previewColor: string;
}

export const THEME_CONFIGS: Record<ThemeMode, ThemeConfig> = {
  light: {
    id: 'light',
    name: 'الأبيض المؤسسي (SAP Shell White)',
    description: 'خلفية #F5F6F7 وكروت بيضاء على نمط Fiori 3 — الأعلى وضوحاً تحت الإضاءة المكتبية.',
    bgClass: 'bg-[#f5f6f7] text-[#1d2d3e]',
    cardBgClass: 'bg-white border-[#d5dade]',
    textPrimaryClass: 'text-[#1d2d3e]',
    accentClass: 'bg-[#0070f2] text-white hover:bg-[#005ac1]',
    borderClass: 'border-[#d5dade]',
    previewColor: '#f5f6f7',
  },
  frosted_glass: {
    id: 'frosted_glass',
    name: 'الكريستالي الزجاجي (Frosted Crystal)',
    description: 'خلفية سماوية خفيفة من صميم الشعار — تعكس واجهات المحل الزجاجية دون وهج أبيض.',
    bgClass: 'bg-[#eef3f9] text-[#0b1a2e] backdrop-blur-3xl',
    cardBgClass: 'bg-white/80 border-white shadow-xl backdrop-blur-2xl',
    textPrimaryClass: 'text-[#0b1a2e]',
    accentClass: 'bg-[#0070f2] text-white hover:bg-[#005ac1]',
    borderClass: 'border-[#ccd8e6]',
    previewColor: '#eef3f9',
  },
  dark: {
    id: 'dark',
    name: 'الكحلي المؤسسي (Logo Navy)',
    description: 'كحلي الشعار نفسه (#001020) — الراحة البصرية في ورديات الليل مع هوية موحّدة.',
    bgClass: 'bg-[#001020] text-[#eaf2ff]',
    cardBgClass: 'bg-[#001630] border-[#16365e]',
    textPrimaryClass: 'text-[#eaf2ff]',
    accentClass: 'bg-[#3fa6ff] text-[#001020] hover:bg-[#84c2ff]',
    borderClass: 'border-[#16365e]',
    previewColor: '#001020',
  },
  oled: {
    id: 'oled',
    name: 'الأسود المطلق (OLED True Black)',
    description: 'توفير فائ لطاقة شاشات OLED مع أعلى نسبة تباين في النظام — للكاشير الليلي.',
    bgClass: 'bg-black text-[#f0f6ff]',
    cardBgClass: 'bg-[#000714] border-[#0d2a52]',
    textPrimaryClass: 'text-[#f0f6ff]',
    accentClass: 'bg-[#4fb0ff] text-black hover:bg-[#9cd0ff]',
    borderClass: 'border-[#0d2a52]',
    previewColor: '#000000',
  },
  royal_gold: {
    id: 'royal_gold',
    name: 'الياقوتية (Royal Sapphire)',
    description: 'أزرق عميق مستخرج من الطرف الداكن للشعار — للضيافة والمتاجر الراقية.',
    bgClass: 'bg-[#050b1c] text-[#eaf0ff]',
    cardBgClass: 'bg-[#0a1430] border-[#233c78]',
    textPrimaryClass: 'text-[#eaf0ff]',
    accentClass: 'bg-[#7fb2ff] text-[#050b1c] font-bold hover:bg-[#b3d0ff]',
    borderClass: 'border-[#233c78]',
    previewColor: '#050b1c',
  },
  high_contrast: {
    id: 'high_contrast',
    name: 'التباين الأعلى (WCAG AAA)',
    description: 'أبيض نقي على أسود مع حدود بيضاء وسمات سماوية — لأشعة الشمس المباشرة في المستودعات.',
    bgClass: 'bg-black text-white',
    cardBgClass: 'bg-black border-2 border-white',
    textPrimaryClass: 'text-white',
    accentClass: 'bg-[#3fa6ff] text-black font-black hover:bg-[#9cd0ff]',
    borderClass: 'border-white',
    previewColor: '#000000',
  },
};

class ThemeService {
  private currentTheme: ThemeMode = 'light';
  private listeners: ((theme: ThemeMode) => void)[] = [];

  constructor() {
    const saved = localStorage.getItem('dypos_theme') as ThemeMode;
    if (saved && THEME_CONFIGS[saved]) {
      this.currentTheme = saved;
    }
    /*
     * Apply immediately.
     *
     * The constructor previously only READ the saved theme. The attribute was
     * written when the user changed it, so on a reload nothing was applied until
     * the first interaction — the app painted a full frame in the default theme
     * and then corrected itself. On a dark-mode terminal that flash is genuinely
     * unpleasant, and for someone who chose high-contrast it is worse: the
     * low-contrast frame is exactly what they are trying to avoid.
     *
     * The attribute is also set in `index.html` for the same reason — this call
     * is the safety net for the case where that inline script is stripped.
     */
    this.applyToDOM();
  }

  public getTheme(): ThemeMode {
    return this.currentTheme;
  }

  public getConfig(): ThemeConfig {
    return THEME_CONFIGS[this.currentTheme];
  }

  public setTheme(theme: ThemeMode) {
    this.currentTheme = theme;
    localStorage.setItem('dypos_theme', theme);
    this.applyToDOM();
    this.listeners.forEach((fn) => fn(theme));
  }

  public subscribe(callback: (theme: ThemeMode) => void) {
    this.listeners.push(callback);
    callback(this.currentTheme);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  public applyToDOM() {
    const root = document.documentElement;
    /*
     * ══ WHY THIS IS AN ATTRIBUTE AND NOT A CLASS ══════════════════════════
     * The design system in `src/index.css` defines its themes as
     *
     *     [data-theme="light"] { --t-canvas: …; --t-ink: …; }
     *     [data-theme="dark"]  { --t-canvas: …; --t-ink: …; }
     *
     * This method used to do `root.classList.add(this.currentTheme)` instead.
     * A class selector and an attribute selector are different things: adding
     * `class="dark"` matches no rule in the stylesheet, so every theme variable
     * kept its `:root` default and the switcher changed nothing at all.
     *
     * That is the entire reason six themes were fully defined and none of them
     * worked. The CSS was correct; the selector it listened on was wrong.
     */
    root.setAttribute('data-theme', this.currentTheme);

    /*
     * `color-scheme` is set too, so the browser's own scrollbars, form controls
     * and on-screen keyboard follow the theme. Without it an OLED theme still
     * shows light scrollbars, which is the detail that makes a dark theme read
     * as unfinished.
     */
    root.style.colorScheme = this.currentTheme === 'light' ? 'light' : 'dark';
  }
}

export const themeService = new ThemeService();
