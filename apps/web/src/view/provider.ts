/**
 * Provider logos next to model names. The SVGs come from `@lobehub/icons-static-svg` (MIT) and
 * are imported as Vite assets, so they ship as hashed files of this site (never a CDN; see
 * `assetsInlineLimit` in `vite.config.ts`). Providers without a logo get a neutral badge with
 * their initials.
 */
import ai2 from "@lobehub/icons-static-svg/icons/ai2-color.svg";
import ai21 from "@lobehub/icons-static-svg/icons/ai21.svg";
import alibaba from "@lobehub/icons-static-svg/icons/alibaba-color.svg";
import arcee from "@lobehub/icons-static-svg/icons/arcee-color.svg";
import baichuan from "@lobehub/icons-static-svg/icons/baichuan-color.svg";
import baidu from "@lobehub/icons-static-svg/icons/baidu-color.svg";
import bytedance from "@lobehub/icons-static-svg/icons/bytedance-color.svg";
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg";
import cohere from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import deepCogito from "@lobehub/icons-static-svg/icons/deepcogito-color.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import essentialAi from "@lobehub/icons-static-svg/icons/essentialai-color.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import grok from "@lobehub/icons-static-svg/icons/grok.svg";
import hunyuan from "@lobehub/icons-static-svg/icons/hunyuan-color.svg";
import ibm from "@lobehub/icons-static-svg/icons/ibm.svg";
import inception from "@lobehub/icons-static-svg/icons/inception.svg";
import inflection from "@lobehub/icons-static-svg/icons/inflection.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import kwaipilot from "@lobehub/icons-static-svg/icons/kwaipilot-color.svg";
import ling from "@lobehub/icons-static-svg/icons/ling-color.svg";
import liquid from "@lobehub/icons-static-svg/icons/liquid.svg";
import longcat from "@lobehub/icons-static-svg/icons/longcat-color.svg";
import meta from "@lobehub/icons-static-svg/icons/meta-color.svg";
import microsoft from "@lobehub/icons-static-svg/icons/microsoft-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import morph from "@lobehub/icons-static-svg/icons/morph-color.svg";
import nous from "@lobehub/icons-static-svg/icons/nousresearch.svg";
import nova from "@lobehub/icons-static-svg/icons/nova-color.svg";
import nvidia from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg";
import perplexity from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import poolside from "@lobehub/icons-static-svg/icons/poolside-color.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import reka from "@lobehub/icons-static-svg/icons/reka.svg";
import relace from "@lobehub/icons-static-svg/icons/relace.svg";
import stepfun from "@lobehub/icons-static-svg/icons/stepfun-color.svg";
import upstage from "@lobehub/icons-static-svg/icons/upstage-color.svg";
import xiaomi from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import yi from "@lobehub/icons-static-svg/icons/yi-color.svg";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import clsx from "clsx";
import type { Html, HtmlBuilder } from "foldkit/html";

import { providerNameOfSlug, providerOf } from "../domain/palette.ts";

/** Logo URL per provider slug (OpenRouter id prefix). */
const ICONS: ReadonlyArray<readonly [slug: string, url: string]> = [
  ["anthropic", claude],
  ["openai", openai],
  ["google", gemini],
  ["x-ai", grok],
  ["deepseek", deepseek],
  ["qwen", qwen],
  ["moonshotai", kimi],
  ["z-ai", zhipu],
  ["thudm", zhipu],
  ["mistralai", mistral],
  ["minimax", minimax],
  ["meta-llama", meta],
  ["meta", meta],
  ["nvidia", nvidia],
  ["cohere", cohere],
  ["amazon", nova],
  ["bytedance-seed", bytedance],
  ["bytedance", bytedance],
  ["xiaomi", xiaomi],
  ["microsoft", microsoft],
  ["ai21", ai21],
  ["inflection", inflection],
  ["perplexity", perplexity],
  ["openrouter", openrouter],
  ["arcee-ai", arcee],
  ["baidu", baidu],
  ["tencent", hunyuan],
  ["stepfun-ai", stepfun],
  ["stepfun", stepfun],
  ["nousresearch", nous],
  ["liquid", liquid],
  ["inception", inception],
  ["ibm-granite", ibm],
  ["alibaba", alibaba],
  ["01-ai", yi],
  ["upstage", upstage],
  ["allenai", ai2],
  ["deepcogito", deepCogito],
  ["meituan", longcat],
  ["inclusionai", ling],
  ["morph", morph],
  ["relace", relace],
  ["poolside", poolside],
  ["baichuan", baichuan],
  ["kwaipilot", kwaipilot],
  ["essentialai", essentialAi],
  ["rekaai", reka],
];

/** The logo of a provider slug, if we ship one. */
export const providerIconUrl = (slug: string): string | null =>
  ICONS.find(([candidate]) => candidate === slug)?.[1] ?? null;

/** Up to two initials of a provider name, for providers without a logo (`Arcee AI` → `AA`). */
export const providerInitials = (name: string): string => {
  const words = name.split(/[\s._-]+/).filter((word) => word.length > 0);
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : name[0];

  return (letters ?? "?").toUpperCase();
};

export type IconSize = "xs" | "sm" | "md" | "lg";

const BOX: Readonly<Record<IconSize, string>> = {
  xs: "h-4 w-4 rounded-[4px] text-[7px]",
  sm: "h-5 w-5 rounded-[5px] text-[8px]",
  md: "h-7 w-7 rounded-md text-[10px]",
  lg: "h-12 w-12 rounded-md border-[1.5px] border-line-strong text-base shadow-[2px_2px_0_var(--shadow)]",
};

const IMAGE: Readonly<Record<IconSize, string>> = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-[18px] w-[18px]",
  lg: "h-7 w-7",
};

/**
 * A provider's logo in a small white tile (or its initials on a neutral one). Decorative: the
 * model name sits next to it, so it is hidden from assistive tech; the tooltip names the provider.
 * `displayName` overrides our provider name (the catalog sends its own).
 */
export const providerIcon = <M>(
  h: HtmlBuilder<M>,
  slug: string,
  size: IconSize = "sm",
  displayName: string = providerNameOfSlug(slug),
): Html => {
  const name = displayName;
  const url = providerIconUrl(slug);

  return h.span(
    [
      h.Class(
        clsx(
          "inline-flex shrink-0 items-center justify-center overflow-hidden font-bold leading-none select-none",
          size === "lg" ? "" : "border border-line",
          url === null ? "bg-paper-2 text-ink-2" : "bg-white",
          BOX[size],
        ),
      ),
      h.Title(name),
      h.AriaHidden(true),
    ],
    [
      url === null
        ? providerInitials(name)
        : h.img([
            h.Src(url),
            h.Alt(""),
            h.Class(IMAGE[size]),
            h.Loading("lazy"),
            h.Decoding("async"),
          ]),
    ],
  );
};

/** The provider logo of a competitor id (`anthropic/claude-x:high`). */
export const competitorIcon = <M>(
  h: HtmlBuilder<M>,
  competitorId: string,
  size: IconSize = "sm",
): Html => providerIcon(h, providerOf(competitorId), size);
