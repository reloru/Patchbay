// Pruna AI model catalog — single source of truth for both the Worker
// (allow-list + /api/models) and the browser UI.
//
// Field schema:
//   name          API input key
//   label         plain-language label shown in the UI
//   type          text | textarea | int | number | bool | enum | image
//   required      always sent, no override toggle (default false)
//   default       Pruna's own default (also shown as "Default: …" in the UI)
//   defaultLabel  override for how the default is displayed (e.g. "random")
//   invert        bool only: the on/off shown to the user is the OPPOSITE of
//                 the API value. Used so `disable_safety_checker` can be
//                 presented as a "Content moderation filter" that reads On/Off.
//   min/max/step  numeric bounds (int/number)
//   options       [{value,label}] for enum
//   maxItems      for image arrays (default 1)
//   wrapArray     text/number only: send the single entered value as a
//                 one-element array (for API params that are typed as arrays)
//   presets       text only: [{label,value,hint}] quick-pick dropdown shown
//                 above the input; picking one fills the text value, the
//                 field stays freely editable (e.g. known-good LoRA URLs)
//
// Optional fields render with an override toggle so you only send the
// parameters you actually change; everything else uses Pruna's default.
//
// LoRA / trainer parameters are intentionally omitted.

const AR_COMMON = [
  { value: "1:1", label: "1:1 square" },
  { value: "16:9", label: "16:9 landscape" },
  { value: "9:16", label: "9:16 portrait" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
];

const OUTPUT_FORMAT = {
  name: "output_format",
  label: "File format",
  type: "enum",
  default: "jpg",
  options: [
    { value: "jpg", label: "JPG" },
    { value: "png", label: "PNG" },
    { value: "webp", label: "WebP" },
  ],
};

const OUTPUT_QUALITY = {
  name: "output_quality",
  label: "Image quality",
  type: "int",
  default: 80,
  min: 0,
  max: 100,
};

const SEED = {
  name: "seed",
  label: "Seed",
  type: "int",
  default: "",
  min: -1,
  defaultLabel: "random",
};

// Content moderation filter. The API param disables the safety checker, so we
// present it inverted: filter "On" == param false.
// `default` is what the app shows and will send; `apiDefault` is what the
// provider does when the field is omitted. They are not always the same: we
// want the filter off, but most models only disable it when explicitly told
// to. buildInput() sends any value that differs from apiDefault, so a
// mismatch here is what makes the shown default actually take effect rather
// than just being a label.
function moderationFilter(name = "disable_safety_checker", apiDefault = false) {
  return { name, label: "Content moderation filter", type: "bool", default: true, apiDefault, invert: true };
}

export const MODELS = [
  // ───────────────────────── Image generation ─────────────────────────
  {
    id: "flux-dev",
    label: "FLUX.1 dev",
    group: "Image generation",
    kind: "image",
    blurb: "High-quality text-to-image (FLUX.1-dev) with speed presets.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "1:1",
        options: [
          ...AR_COMMON,
          { value: "21:9", label: "21:9 ultrawide" },
          { value: "9:21", label: "9:21" },
          { value: "4:5", label: "4:5" },
          { value: "5:4", label: "5:4" },
        ],
      },
      {
        name: "speed_mode",
        label: "Speed vs. quality",
        type: "enum",
        default: "Extra Juiced 🔥 (more speed)",
        options: [
          { value: "Lightly Juiced 🍊 (more consistent)", label: "Most consistent" },
          { value: "Juiced 🔥 (default)", label: "Balanced" },
          { value: "Extra Juiced 🔥 (more speed)", label: "Faster" },
          { value: "Blink of an eye 👁️", label: "Fastest" },
        ],
      },
      { name: "num_inference_steps", label: "Detail (steps)", type: "int", default: 28, min: 1, max: 50 },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 3.5, min: 0, max: 20, step: 0.1 },
      { name: "image_size", label: "Resolution (longest side)", type: "int", default: 1024, min: 256, max: 2048, step: 16 },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      SEED,
    ],
  },
  {
    id: "flux-dev-lora",
    label: "FLUX.1 dev (LoRA)",
    group: "Image generation",
    kind: "image",
    blurb: "FLUX.1 dev with up to two HuggingFace LoRAs applied.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "lora", label: "LoRA (HuggingFace)", type: "text", required: true, help: 'HuggingFace repo in "owner/model-name" format.' },
      { name: "lora_scale", label: "LoRA strength", type: "number", default: 1, min: -1, max: 3, step: 0.05 },
      { name: "extra_lora", label: "2nd LoRA (HuggingFace, optional)", type: "text" },
      { name: "extra_lora_scale", label: "2nd LoRA strength", type: "number", default: 1, min: -1, max: 3, step: 0.05 },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "1:1",
        options: [
          ...AR_COMMON,
          { value: "21:9", label: "21:9 ultrawide" },
          { value: "9:21", label: "9:21" },
          { value: "4:5", label: "4:5" },
          { value: "5:4", label: "5:4" },
        ],
      },
      {
        name: "speed_mode",
        label: "Speed vs. quality",
        type: "enum",
        default: "Extra Juiced 🔥 (more speed)",
        options: [
          { value: "Lightly Juiced 🍊 (more consistent)", label: "Most consistent" },
          { value: "Juiced 🔥 (default)", label: "Balanced" },
          { value: "Extra Juiced 🔥 (more speed)", label: "Faster" },
          { value: "Blink of an eye 👁️", label: "Fastest" },
        ],
      },
      { name: "num_inference_steps", label: "Detail (steps)", type: "int", default: 28, min: 1, max: 50 },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 3.5, min: 0, max: 20, step: 0.1 },
      { name: "image_size", label: "Resolution (longest side)", type: "int", default: 1024, min: 256, max: 2048, step: 16 },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      SEED,
    ],
  },
  {
    id: "flux-2-klein-4b",
    label: "FLUX.2 Klein 4B",
    group: "Image generation",
    kind: "image",
    blurb: "Very cheap, fast text-to-image; also accepts reference images.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "1:1",
        options: [
          ...AR_COMMON,
          { value: "21:9", label: "21:9 ultrawide" },
          { value: "9:21", label: "9:21" },
          { value: "4:5", label: "4:5" },
          { value: "5:4", label: "5:4" },
          { value: "match_input_image", label: "Keep reference image size" },
        ],
      },
      { name: "images", label: "Reference image(s) (optional)", type: "image", maxItems: 5, asArray: true },
      {
        name: "output_megapixels",
        label: "Output size",
        type: "enum",
        default: "1",
        options: [
          { value: "0.25", label: "0.25 MP (smallest)" },
          { value: "0.5", label: "0.5 MP" },
          { value: "1", label: "1 MP" },
          { value: "2", label: "2 MP" },
          { value: "4", label: "4 MP (largest)" },
        ],
      },
      { name: "go_fast", label: "Fast mode", type: "bool", default: false },
      OUTPUT_FORMAT,
      { ...OUTPUT_QUALITY, default: 95 },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "qwen-image",
    label: "Qwen-Image",
    group: "Image generation",
    kind: "image",
    blurb: "Text-to-image with strong text rendering; optional img2img.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "lora_weights",
        label: "LoRA (HuggingFace/URL, optional)",
        type: "text",
        help: "URL to LoRA weights (.safetensors, .tar, or .zip) — e.g. huggingface.co/<owner>/<model>/<file>.safetensors. Include the exact filename; Pruna's default filename guess often 404s otherwise. Presets are community LoRAs (not Pruna-trained) — verified working, but not officially supported.",
        presets: [
          {
            label: "Photorealism (flymy-ai)",
            value: "huggingface.co/flymy-ai/qwen-image-realism-lora/flymy_realism.safetensors",
            hint: "realism",
          },
          {
            label: "General purpose (flymy-ai)",
            value: "huggingface.co/flymy-ai/qwen-image-lora/pytorch_lora_weights.safetensors",
          },
          {
            label: "Realistic headshots (HeadshotX)",
            value: "huggingface.co/prithivMLmods/Qwen-Image-HeadshotX/Qwen-Image-HeadshotX.safetensors",
            hint: "face headshot",
          },
          {
            label: "Studio realism",
            value: "huggingface.co/prithivMLmods/Qwen-Image-Studio-Realism/qwen-studio-realism.safetensors",
            hint: "Studio Realism",
          },
        ],
      },
      { name: "lora_scale", label: "LoRA strength", type: "number", default: 1, min: -1, max: 3, step: 0.05 },
      { name: "extra_lora_weights", label: "2nd LoRA (optional)", type: "text", wrapArray: true },
      { name: "extra_lora_scale", label: "2nd LoRA strength", type: "number", default: 1, min: -1, max: 3, step: 0.05, wrapArray: true },
      { name: "negative_prompt", label: "Things to avoid", type: "text", default: "" },
      { name: "aspect_ratio", label: "Aspect ratio", type: "enum", default: "16:9", options: AR_COMMON },
      { name: "num_inference_steps", label: "Detail (steps)", type: "int", default: 30, min: 1, max: 50 },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 3, min: 0, max: 10, step: 0.1 },
      { name: "enhance_prompt", label: "Auto-improve prompt", type: "bool", default: false },
      { name: "go_fast", label: "Fast mode", type: "bool", default: true },
      {
        name: "image_size",
        label: "Optimize for",
        type: "enum",
        default: "optimize_for_quality",
        options: [
          { value: "optimize_for_quality", label: "Quality" },
          { value: "optimize_for_speed", label: "Speed" },
        ],
      },
      { name: "image", label: "Starting image (optional)", type: "image" },
      { name: "strength", label: "How much to change it", type: "number", default: 0.9, min: 0, max: 1, step: 0.05 },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "qwen-image-fast",
    label: "Qwen-Image Fast",
    group: "Image generation",
    kind: "image",
    blurb: "Faster Qwen-Image variant with a creativity dial.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "16:9",
        options: [...AR_COMMON, { value: "custom", label: "Custom size" }],
      },
      { name: "width", label: "Width (custom size)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "height", label: "Height (custom size)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "creativity", label: "Creativity", type: "number", default: 0.62, min: 0, max: 1, step: 0.01 },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "z-image-turbo",
    label: "Z-Image Turbo",
    group: "Image generation",
    kind: "image",
    blurb: "Turbo text-to-image; very low step counts.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "width", label: "Width", type: "int", default: 1024, min: 64, max: 2048, step: 8 },
      { name: "height", label: "Height", type: "int", default: 1024, min: 64, max: 2048, step: 8 },
      { name: "num_inference_steps", label: "Detail (steps)", type: "int", default: 8, min: 1, max: 50 },
      { name: "guidance_scale", label: "Prompt adherence", type: "number", default: 0, min: 0, max: 20, step: 0.1 },
      { name: "go_fast", label: "Fast mode", type: "bool", default: false },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      SEED,
    ],
  },
  {
    id: "z-image-turbo-lora",
    label: "Z-Image Turbo (LoRA)",
    group: "Image generation",
    kind: "image",
    blurb: "Z-Image Turbo with a custom LoRA (.safetensors/.tar/.zip URL, any host).",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "lora_weights",
        label: "LoRA weights (URL)",
        type: "text",
        required: true,
        wrapArray: true,
        help: "URL to a .safetensors, .tar, or .zip LoRA file — HuggingFace or any other host.",
      },
      { name: "lora_scales", label: "LoRA strength", type: "number", default: 1, min: -1, max: 3, step: 0.05, wrapArray: true },
      { name: "width", label: "Width", type: "int", default: 1024, min: 64, max: 2048, step: 8 },
      { name: "height", label: "Height", type: "int", default: 1024, min: 64, max: 2048, step: 8 },
      { name: "num_inference_steps", label: "Detail (steps)", type: "int", default: 8, min: 1, max: 50 },
      { name: "guidance_scale", label: "Prompt adherence", type: "number", default: 0, min: 0, max: 20, step: 0.1 },
      { name: "go_fast", label: "Fast mode", type: "bool", default: false },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      SEED,
    ],
  },
  {
    id: "z-image-turbo-small",
    label: "Z-Image Turbo (Small)",
    group: "Image generation",
    kind: "image",
    // Try-Sync doesn't return quickly for this model — confirmed live, it hangs
    // to a 60s gateway 504 instead of falling back to a pollable id. Force the
    // async path so the UI polls /api/status like the other slow models do.
    forceAsync: true,
    blurb: "Smaller/cheaper Z-Image Turbo variant. Prompt only — no size or step controls.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "go_fast", label: "Fast mode", type: "bool", default: false },
      SEED,
    ],
  },
  {
    id: "p-image",
    label: "P-Image",
    group: "Image generation",
    kind: "image",
    blurb: "Pruna's proprietary image model with prompt enhancement + refinement.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "16:9",
        options: [...AR_COMMON, { value: "custom", label: "Custom size" }],
      },
      { name: "width", label: "Width (custom size)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "height", label: "Height (custom size)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "prompt_upsampling", label: "Auto-improve prompt", type: "bool", default: false },
      SEED,
      moderationFilter(),
    ],
  },
  // p-image-pro is documented (prompt, aspect_ratio, width, height, seed,
  // disable_safety_checker; $0.01 per image) but is NOT in this catalogue: as
  // of 2026-09-08 every call to it, including a bare prompt, is refused before
  // any input validation with
  //   422 {"title":"Deployment disabled","detail":"This deployment is
  //        currently disabled: - This deployment has been disabled in its
  //        settings."}
  // Listing a model that cannot run is worse than leaving it out. Re-adding it
  // is this comment plus a "p-image-pro": {type:"flat", usd:0.01} price entry,
  // once Pruna enables the deployment.
  {
    id: "p-image-lora",
    label: "P-Image-LoRA",
    group: "Image generation",
    kind: "image",
    blurb: "P-Image with a custom LoRA (must be trained via p-image-trainer).",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "lora_weights",
        label: "LoRA weights (HuggingFace file URL)",
        type: "text",
        required: true,
        help: 'huggingface.co/<owner>/<model>/<file>.safetensors — must be trained with p-image-trainer. Include the exact filename (usually "weights.safetensors"); Pruna\'s default filename guess often 404s otherwise. Presets below include their trigger word — add it to your prompt.',
        presets: [
          {
            label: "Photorealism",
            value: "huggingface.co/PrunaAI/p-image-photos-realism-lora/weights.safetensors",
            hint: "Realism",
          },
          {
            label: "Pixel art",
            value: "huggingface.co/PrunaAI/p-image-pixel-art-lora/weights.safetensors",
            hint: "pixel art style",
          },
          {
            label: "Modernism art",
            value: "huggingface.co/PrunaAI/p-image-photos-modernism-art-lora/weights.safetensors",
            hint: "DADADOLL style",
          },
          {
            label: "Pencil sketch",
            value: "huggingface.co/PrunaAI/p-image-pencil-sketch-art-lora/weights.safetensors",
          },
          {
            label: "Classic film photo",
            value: "huggingface.co/PrunaAI/p-image-photos-classic-film-lora/weights.safetensors",
            hint: "t3chnic4lly",
          },
          {
            label: "Comic noir",
            value: "huggingface.co/PrunaAI/p-image-comic-noir-art-lora/weights.safetensors",
            hint: "tok_comic_noir",
          },
          {
            label: "Classic painting",
            value: "huggingface.co/PrunaAI/p-image-classic-painting-lora/weights.safetensors",
            hint: "class1cpa1nt",
          },
          {
            label: "Sun-bleached photo",
            value: "huggingface.co/PrunaAI/p-image-photos-sunbleached-lora/weights.safetensors",
            hint: "Act1vate!",
          },
          {
            label: "Three-color composite photo",
            value: "huggingface.co/PrunaAI/p-image-photos-three-color-composite/weights.safetensors",
            hint: "HST",
          },
        ],
      },
      { name: "lora_scale", label: "LoRA strength", type: "number", default: 0.5, min: -1, max: 3, step: 0.05 },
      { name: "hf_api_token", label: "HuggingFace API token", type: "text" },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "16:9",
        options: [...AR_COMMON, { value: "custom", label: "Custom size" }],
      },
      { name: "width", label: "Width (custom size)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "height", label: "Height (custom size)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "prompt_upsampling", label: "Auto-improve prompt", type: "bool", default: false },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-image-ideogram",
    label: "P-Image-Ideogram",
    group: "Image generation",
    kind: "image",
    blurb: "Ideogram-style generation with an adjustable thinking effort dial.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "thinking",
        label: "Thinking effort",
        type: "enum",
        default: "medium",
        options: [
          { value: "very low", label: "Very low" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
      {
        name: "image_size",
        label: "Resolution budget",
        type: "enum",
        default: "2K",
        options: [
          { value: "1K", label: "1K" },
          { value: "2K", label: "2K" },
        ],
      },
      { name: "prompt_upsampling", label: "Auto-improve prompt", type: "bool", default: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "1:1",
        options: [...AR_COMMON, { value: "custom", label: "Custom size" }],
      },
      { name: "width", label: "Width (custom size)", type: "int", default: 1024, min: 256, max: 2560, step: 16 },
      { name: "height", label: "Height (custom size)", type: "int", default: 1024, min: 256, max: 2560, step: 16 },
      SEED,
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
    ],
  },

  {
    id: "wan-image-small",
    label: "WAN Image Small",
    group: "Image generation",
    kind: "image",
    blurb: "Lightweight text-to-image; can return up to 4 variations at once.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "16:9",
        options: [
          { value: "1:1", label: "1:1 square" },
          { value: "16:9", label: "16:9 landscape" },
          { value: "9:16", label: "9:16 portrait" },
          { value: "4:3", label: "4:3" },
          { value: "3:4", label: "3:4" },
          { value: "21:9", label: "21:9 ultrawide" },
          { value: "custom", label: "Custom size" },
        ],
      },
      { name: "width", label: "Width (custom size)", type: "int", default: 1024, min: 256, max: 2048, step: 16 },
      { name: "height", label: "Height (custom size)", type: "int", default: 1024, min: 256, max: 2048, step: 16 },
      { name: "num_outputs", label: "How many images", type: "int", default: 1, min: 1, max: 4 },
      { name: "juiced", label: "Fast mode (juiced)", type: "bool", default: false },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      SEED,
    ],
  },


  // ───────────────────────── Image editing ─────────────────────────
  {
    id: "p-image-edit",
    label: "P-Image-Edit",
    group: "Image editing",
    kind: "image",
    blurb: "Compose / edit from 1–5 reference images.",
    fields: [
      { name: "images", label: "Image(s) to edit", type: "image", required: true, maxItems: 5, asArray: true },
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      // Pruna turns turbo on unless told otherwise, so this has to be sent.
      { name: "turbo", label: "Fast mode (turbo)", type: "bool", default: false, apiDefault: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "match_input_image",
        options: [{ value: "match_input_image", label: "Keep original" }, ...AR_COMMON],
      },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-image-edit-lora",
    label: "P-Image-Edit-LoRA",
    group: "Image editing",
    kind: "image",
    blurb: "P-Image-Edit with a custom LoRA (must be trained via p-image-edit-trainer).",
    fields: [
      { name: "images", label: "Image(s) to edit", type: "image", required: true, maxItems: 5, asArray: true },
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "lora_weights",
        label: "LoRA weights (HuggingFace file URL)",
        type: "text",
        required: true,
        // Pruna's API guesses `pytorch_lora_weights.safetensors` when no filename is
        // given, but p-image-edit-trainer (and these official presets) output
        // `weights.safetensors` — always spell out the filename or it 404s.
        presets: [
          {
            label: "Photo → anime",
            value: "huggingface.co/PrunaAI/p-image-edit-photo-to-anime-lora/weights.safetensors",
            hint: "transform into anime",
          },
          {
            label: "Dotted illustration",
            value: "huggingface.co/PrunaAI/p-image-edit-dotted-illustration-lora/weights.safetensors",
            hint: "dotted illustration",
          },
          {
            label: "Photo enhancement",
            value: "huggingface.co/PrunaAI/p-image-edit-photo-enhancement-lora/weights.safetensors",
            hint: "tok_enhance",
          },
          {
            label: "Skin retouching",
            value: "huggingface.co/PrunaAI/p-image-edit-skin-retouching-lora/weights.safetensors",
            hint: "make the subjects skin details more prominent and natural",
          },
          {
            label: "Next scene",
            value: "huggingface.co/PrunaAI/p-image-edit-next-scene-lora/weights.safetensors",
            hint: "Next Scene: <describe what happens next>",
          },
          {
            label: "Photo upscaler",
            value: "huggingface.co/PrunaAI/p-image-edit-photo-upscaler-lora/weights.safetensors",
            hint: "Upscale this picture to 4K resolution.",
          },
        ],
      },
      { name: "lora_scale", label: "LoRA strength", type: "number", default: 1, min: -1, max: 3, step: 0.05 },
      { name: "hf_api_token", label: "HuggingFace API token", type: "text" },
      { name: "turbo", label: "Fast mode (turbo)", type: "bool", default: false },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "match_input_image",
        options: [{ value: "match_input_image", label: "Keep original" }, ...AR_COMMON],
      },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-image-edit-text-aware",
    label: "P-Image-Edit-Text-Aware",
    group: "Image editing",
    kind: "image",
    blurb: "Edit that picks the best model for the input; costs more when the image contains text.",
    fields: [
      {
        name: "images",
        label: "Image(s) to edit",
        type: "image",
        required: true,
        maxItems: 5,
        asArray: true,
        help: "Main image first. Pruna documents no upper count; 5 matches the other edit models here.",
      },
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "match_input_image",
        options: [{ value: "match_input_image", label: "Keep original" }, ...AR_COMMON],
      },
      // Documented default is on, unlike p-image-edit above, where turbo is
      // deliberately forced off. Left at the documented value rather than
      // assuming that choice carries over; the docs say to turn it off for
      // complicated edits.
      { name: "turbo", label: "Fast mode (turbo)", type: "bool", default: true },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-image-rmbg",
    label: "P-Image-RMBG",
    group: "Image editing",
    kind: "image",
    blurb: "Remove the background and return a transparent PNG. Flat price at any size.",
    // The whole documented input: one image, no options at all.
    fields: [{ name: "image", label: "Image", type: "image", required: true }],
  },
  {
    id: "p-image-try-on",
    label: "P-Image-Try-On",
    group: "Image editing",
    kind: "image",
    blurb: "Put garments from reference photos onto a person.",
    fields: [
      { name: "person_image", label: "Person photo", type: "image", required: true },
      { name: "garment_images", label: "Garment photo(s)", type: "image", required: true, maxItems: 6, asArray: true },
      { name: "prompt", label: "Extra guidance (optional)", type: "text", default: "" },
      { name: "turbo", label: "Fast mode (turbo)", type: "bool", default: false },
      { name: "reference_pose", label: "Reference pose image (experimental)", type: "image" },
      { name: "preserve_input_size", label: "Keep original size", type: "bool", default: true },
      OUTPUT_FORMAT,
      { ...OUTPUT_QUALITY, default: 95 },
      SEED,
    ],
  },
  {
    id: "p-try-on-glasses",
    label: "P-Try-On-Glasses",
    group: "Image editing",
    kind: "image",
    // Confirmed live: a real run took ~238s, and Try-Sync hangs to a 60s
    // gateway 504 rather than returning a pollable id quickly. Force async so
    // the UI polls /api/status instead of eating a guaranteed timeout.
    forceAsync: true,
    // Measured, not estimated: a real run took ~238s. Surfaced in the status
    // line while the job is in flight, because a four-minute wait with no stated
    // expectation reads as a hang and gets abandoned — which wastes the run,
    // since the job keeps going and billing on Pruna after the tab closes.
    typicalSeconds: 238,
    blurb: "Put a pair of glasses from a reference photo onto a person. Slow — usually about 4 minutes.",
    fields: [
      { name: "person", label: "Person photo", type: "image", required: true },
      { name: "glass", label: "Glasses photo", type: "image", required: true },
      moderationFilter(),
    ],
  },
  {
    id: "p-image-upscale",
    label: "P-Image-Upscale",
    group: "Image editing",
    kind: "image",
    blurb: "Upscale an image to a target megapixel count.",
    fields: [
      { name: "image", label: "Image to upscale", type: "image", required: true },
      { name: "target", label: "Target size (megapixels)", type: "int", default: 4, min: 1, max: 128 },
      { name: "enhance_details", label: "Enhance fine details", type: "bool", default: false },
      { name: "enhance_realism", label: "Enhance realism", type: "bool", default: false },
      OUTPUT_FORMAT,
      { ...OUTPUT_QUALITY, default: 100 },
      moderationFilter(),
    ],
  },

  // ───────────────────────── LoRA training ─────────────────────────
  // Produces trained LoRA weights (a .zip of .safetensors), not an image or
  // video, so it uses kind: "file" — the UI shows a plain download instead of
  // an <img>/<video> preview. Output link expires ~30 min after training
  // finishes, and a run can take minutes to hours: pass the resulting
  // lora_weights URL into P-Image-Edit-LoRA above to use it, and consider
  // uploading the .safetensors to your own Hugging Face repo before it expires.
  {
    id: "qwen-image-edit-plus",
    label: "Qwen-Image-Edit Plus",
    group: "Image editing",
    kind: "image",
    blurb: "Edit / transform 1–2 input images from a text instruction.",
    fields: [
      { name: "image", label: "Image(s) to edit", type: "image", required: true, maxItems: 2, asArray: true },
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "go_fast", label: "Fast mode", type: "bool", default: false },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "match_input_image",
        options: [
          { value: "match_input_image", label: "Keep original" },
          { value: "1:1", label: "1:1" },
          { value: "16:9", label: "16:9" },
          { value: "9:16", label: "9:16" },
          { value: "4:3", label: "4:3" },
          { value: "3:4", label: "3:4" },
        ],
      },
      OUTPUT_FORMAT,
      { ...{ ...OUTPUT_QUALITY, default: 100 }, default: 100 },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-image-trainer",
    label: "P-Image-Trainer",
    group: "LoRA training",
    kind: "file",
    blurb: "Train a LoRA for P-Image-LoRA from a folder of images. Async only; output expires ~30 min after it finishes.",
    fields: [
      {
        name: "image_data",
        label: "Training images (.zip)",
        type: "image",
        required: true,
        accept: ".zip,application/zip",
        help: "ZIP of at least 10 images. Add a matching .txt beside any image to caption it (photo.jpg + photo.txt).",
      },
      {
        name: "training_type",
        label: "What to learn",
        type: "enum",
        default: "balanced",
        options: [
          { value: "balanced", label: "Balanced — mixed content and style" },
          { value: "content", label: "Content — subjects, characters, objects" },
          { value: "style", label: "Style — palettes and aesthetic treatments" },
        ],
      },
      { name: "steps", label: "Training steps", type: "int", default: 1000, min: 100, max: 5000, step: 100 },
      {
        name: "default_caption",
        label: "Default caption (images without a .txt)",
        type: "text",
        default: "",
        help: "Required if any image lacks a caption file — training fails without one.",
      },
    ],
  },
  {
    id: "p-image-edit-trainer",
    label: "P-Image-Edit-Trainer",
    group: "LoRA training",
    kind: "file",
    blurb: "Train a custom LoRA from before/after image pairs. Slow — minutes to hours.",
    fields: [
      {
        name: "image_data",
        label: "Training pairs (.zip)",
        type: "image",
        required: true,
        accept: ".zip,application/zip",
        help: 'ZIP of ROOT_start.EXT / ROOT_end.EXT image pairs (e.g. "cat_start.jpg" + "cat_end.jpg").',
      },
      { name: "steps", label: "Training steps", type: "int", default: 1000, min: 100, max: 5000, step: 100 },
      { name: "learning_rate", label: "Learning rate", type: "number", default: 0.0001, min: 0.00001, max: 0.01, step: 0.00001 },
      { name: "default_caption", label: "Default caption (pairs without a .txt)", type: "text", default: "" },
    ],
  },

  // ───────────────────────── Video ─────────────────────────
  {
    id: "wan-t2v",
    label: "WAN Text-to-Video",
    group: "Video",
    kind: "video",
    blurb: "Text-to-video, 480p/720p, 16:9 or 9:16.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "num_frames", label: "Length (frames)", type: "int", default: 81, min: 81, max: 121 },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "480p",
        options: [{ value: "480p", label: "480p" }, { value: "720p", label: "720p" }],
      },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "16:9",
        options: [{ value: "16:9", label: "16:9 landscape" }, { value: "9:16", label: "9:16 portrait" }],
      },
      { name: "frames_per_second", label: "Frames per second", type: "int", default: 16, min: 5, max: 30 },
      { name: "interpolate_output", label: "Smooth motion", type: "bool", default: true },
      { name: "go_fast", label: "Fast mode", type: "bool", default: true },
      { name: "optimize_prompt", label: "Auto-improve prompt", type: "bool", default: false },
      { name: "sample_shift", label: "Motion strength", type: "number", default: 12, min: 1, max: 20, step: 0.5 },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "wan-i2v",
    label: "WAN Image-to-Video",
    group: "Video",
    kind: "video",
    blurb: "Animate a still image into a video.",
    fields: [
      { name: "image", label: "Starting image", type: "image", required: true },
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "num_frames", label: "Length (frames)", type: "int", default: 81, min: 81, max: 121 },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "480p",
        options: [{ value: "480p", label: "480p" }, { value: "720p", label: "720p" }],
      },
      { name: "frames_per_second", label: "Frames per second", type: "int", default: 16, min: 5, max: 30 },
      { name: "last_image", label: "Ending image (optional)", type: "image" },
      { name: "interpolate_output", label: "Smooth motion", type: "bool", default: false },
      { name: "go_fast", label: "Fast mode", type: "bool", default: true },
      { name: "sample_shift", label: "Motion strength", type: "number", default: 12, min: 1, max: 20, step: 0.5 },
      { name: "lora_weights_transformer", label: "LoRA (Hugging Face / .safetensors URL)", type: "text", default: "" },
      { name: "lora_scale_transformer", label: "LoRA strength", type: "number", default: 1, min: -1, max: 3, step: 0.1 },
      { name: "lora_weights_transformer_2", label: "Second LoRA URL (optional)", type: "text", default: "" },
      { name: "lora_scale_transformer_2", label: "Second LoRA strength", type: "number", default: 1, min: -1, max: 3, step: 0.1 },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-video",
    label: "P-Video",
    group: "Video",
    kind: "video",
    blurb: "Text-, image- or audio-conditioned video up to 20s, 720p/1080p.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "image", label: "Starting image (optional)", type: "image" },
      { name: "last_frame_image", label: "Ending image (optional)", type: "image" },
      { name: "audio", label: "Audio track (optional, sets length)", type: "image", accept: "audio/*" },
      { name: "duration", label: "Length (seconds)", type: "int", default: 5, min: 1, max: 20 },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "720p",
        options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }],
      },
      {
        // Number, not "24": the option values are numbers, and the
        // default-comparison that decides what gets sent is type-strict.
        name: "fps",
        label: "Frames per second",
        type: "enum",
        default: 24,
        options: [{ value: 24, label: "24" }, { value: 48, label: "48" }],
      },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "16:9",
        options: AR_COMMON,
        disabledWhen: "image",
        disabledNote: "using the start image's aspect ratio",
      },
      { name: "draft", label: "Draft mode (faster preview)", type: "bool", default: false },
      { name: "prompt_upsampling", label: "Auto-improve prompt", type: "bool", default: false },
      { name: "save_audio", label: "Save With Audio", type: "bool", default: true },
      SEED,
      moderationFilter("disable_safety_filter", true),
    ],
  },
  {
    id: "p-video-edit",
    label: "P-Video-Edit",
    group: "Video",
    kind: "video",
    blurb: "Edit an existing video from a text prompt, optionally guided by reference images.",
    fields: [
      {
        name: "video",
        label: "Video to edit (.mp4)",
        type: "image",
        accept: "video/*",
        required: true,
        help: "Maximum length: 15 seconds.",
      },
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        name: "images",
        label: "Reference image(s) (optional)",
        type: "image",
        maxItems: 4,
        asArray: true,
        help: "Guides identity or style. jpg, jpeg, png or webp.",
      },
      { name: "prompt_upsampling", label: "Auto-improve prompt", type: "bool", default: true },
      { name: "draft", label: "Draft mode (faster preview)", type: "bool", default: false },
      { name: "save_audio", label: "Save With Audio", type: "bool", default: true },
      SEED,
    ],
  },
  {
    id: "p-video-2",
    label: "P-Video-2",
    group: "Video",
    kind: "video",
    blurb: "Premium successor to P-Video: same inputs, up to 1080p, and the length can be left to the model.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "image", label: "Starting image (optional)", type: "image" },
      { name: "last_frame_image", label: "Ending image (optional)", type: "image" },
      { name: "audio", label: "Audio track (optional, sets length)", type: "image", accept: "audio/*" },
      {
        // Blank by default on purpose: unlike p-video this model picks the
        // length from the prompt when duration is omitted, so an empty box is
        // a real setting rather than a missing one.
        name: "duration",
        label: "Length (seconds)",
        type: "int",
        default: "",
        min: 1,
        max: 20,
        defaultLabel: "model decides",
      },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "720p",
        options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }],
      },
      {
        // Numbers, not strings — the default comparison that decides what gets
        // sent is type-strict. Same as p-video above.
        name: "fps",
        label: "Frames per second",
        type: "enum",
        default: 24,
        options: [{ value: 24, label: "24" }, { value: 48, label: "48" }],
      },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "16:9",
        options: AR_COMMON,
        disabledWhen: "image",
        disabledNote: "using the start image's aspect ratio",
      },
      { name: "draft", label: "Draft mode (faster preview)", type: "bool", default: false },
      { name: "prompt_upsampling", label: "Auto-improve prompt", type: "bool", default: true },
      { name: "save_audio", label: "Save With Audio", type: "bool", default: true },
      SEED,
      moderationFilter("disable_safety_filter", true),
    ],
  },
  {
    id: "p-video-infiniteworlds",
    label: "P-Video-InfiniteWorlds",
    group: "Video",
    kind: "video",
    blurb: "World-exploration video from a prompt, optionally seeded with a starting image. One flat per-second rate.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "image", label: "Starting image (optional)", type: "image" },
      { name: "last_frame_image", label: "Ending image (optional)", type: "image" },
      { name: "audio", label: "Audio track (optional, sets length)", type: "image", accept: "audio/*" },
      { name: "duration", label: "Length (seconds)", type: "int", default: 5, min: 1, max: 20 },
      {
        name: "fps",
        label: "Frames per second",
        type: "enum",
        default: 24,
        options: [{ value: 24, label: "24" }, { value: 48, label: "48" }],
      },
      { name: "save_audio", label: "Save With Audio", type: "bool", default: true },
      SEED,
    ],
  },
  {
    id: "p-video-animate",
    label: "P-Video-Animate",
    group: "Video",
    kind: "video",
    blurb: "Make a person from a photo copy the motion in a source video.",
    fields: [
      { name: "video", label: "Motion source video (.mp4)", type: "image", accept: "video/*", required: true },
      { name: "image", label: "Photo of subject to animate", type: "image", required: true },
      { name: "instruction_prompt", label: "Extra guidance (optional)", type: "text", default: "" },
      { name: "turbo", label: "Fast mode (turbo)", type: "bool", default: false },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "720p",
        options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }],
      },
      {
        name: "target_fps",
        label: "Frames per second",
        type: "enum",
        default: "original",
        options: [
          { value: "original", label: "Match source video" },
          { value: "24", label: "24" },
          { value: "48", label: "48" },
        ],
      },
      { name: "save_audio", label: "Keep audio", type: "bool", default: true },
      { name: "ignore_audio", label: "Ignore source audio", type: "bool", default: false },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-video-replace",
    label: "P-Video-Replace",
    group: "Video",
    kind: "video",
    blurb: "Swap the person in a video for someone from reference photos.",
    fields: [
      { name: "video", label: "Source video (.mp4)", type: "image", accept: "video/*", required: true },
      { name: "images", label: "Identity photo(s)", type: "image", required: true, maxItems: 3, asArray: true },
      { name: "instruction_prompt", label: "Extra guidance (optional)", type: "text", default: "" },
      { name: "turbo", label: "Fast mode (turbo)", type: "bool", default: false },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "720p",
        options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }],
      },
      {
        name: "target_fps",
        label: "Frames per second",
        type: "enum",
        default: "original",
        options: [
          { value: "original", label: "Match source video" },
          { value: "24", label: "24" },
          { value: "48", label: "48" },
        ],
      },
      { name: "save_audio", label: "Keep audio", type: "bool", default: true },
      { name: "ignore_audio", label: "Ignore source audio", type: "bool", default: false },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-video-avatar",
    label: "P-Video-Avatar",
    group: "Video",
    kind: "video",
    blurb: "Talking-head video from one portrait — type a script or upload audio.",
    fields: [
      { name: "image", label: "Portrait photo", type: "image", required: true },
      {
        name: "voice_script",
        label: "Script to speak",
        type: "textarea",
        required: true,
        help: "Ignored if you upload an audio file below.",
      },
      { name: "audio", label: "Audio file (optional, overrides script)", type: "image", accept: "audio/*" },
      {
        name: "voice",
        label: "Voice",
        type: "enum",
        default: "Zephyr (Female)",
        options: [
          "Zephyr (Female)", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
          "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algenib", "Despina",
          "Erinome", "Laomedeia", "Achernar", "Algieba", "Schedar", "Gacrux", "Pulcherrima",
          "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
          "Alnilam", "Rasalgethi",
        ].map((v) => ({ value: v, label: v })),
      },
      {
        name: "voice_language",
        label: "Language",
        type: "enum",
        default: "English (US)",
        options: [
          "English (US)", "English (UK)", "Spanish", "French", "German", "Italian",
          "Portuguese (Brazil)", "Japanese", "Korean", "Hindi",
        ].map((v) => ({ value: v, label: v })),
      },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "720p",
        options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }],
      },
      { name: "video_prompt", label: "How they should act", type: "text", default: "The person is talking." },
      { name: "voice_prompt", label: "How they should speak", type: "text", default: "Say the following." },
      { name: "negative_prompt", label: "Things to avoid", type: "text", default: "" },
      { name: "strength_negative_prompt", label: "Avoidance strength", type: "number", default: 0.5, min: 0, max: 4, step: 0.1 },
      { name: "disable_prompt_upsampling", label: "Auto-improve prompt", type: "bool", default: false, invert: true },
      SEED,
      moderationFilter("disable_safety_filter", true),
    ],
  },
  {
    id: "vace",
    label: "VACE (reference-to-video)",
    group: "Video",
    kind: "video",
    blurb:
      "Character-consistent video from a prompt + reference images/video/mask. " +
      "Slowest model here — for a usable wait, turn on Speed vs. quality → Fastest, " +
      "drop Detail (steps) to ~15–20 and Length to ~33 frames.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "src_ref_images", label: "Reference image(s)", type: "image", maxItems: 3, asArray: true },
      { name: "src_video", label: "Source video (optional)", type: "image", accept: "video/*" },
      { name: "src_mask", label: "Mask (optional)", type: "image" },
      {
        name: "size",
        label: "Resolution",
        type: "enum",
        default: "832*480",
        options: [
          { value: "832*480", label: "832×480 landscape" },
          { value: "480*832", label: "480×832 portrait" },
          { value: "1280*720", label: "1280×720 landscape" },
          { value: "720*1280", label: "720×1280 portrait" },
        ],
      },
      { name: "frame_num", label: "Length (frames)", type: "int", default: 81, min: 1, max: 81 },
      {
        name: "speed_mode",
        label: "Speed vs. quality",
        type: "enum",
        default: "Lightly Juiced 🍊 (more consistent)",
        options: [
          { value: "Lightly Juiced 🍊 (more consistent)", label: "Most consistent" },
          { value: "Juiced 🔥 (more speed)", label: "Faster" },
          { value: "Extra Juiced 🚀 (even more speed)", label: "Fastest" },
        ],
      },
      { name: "sample_steps", label: "Detail (steps)", type: "int", default: 50, min: 1, max: 100 },
      {
        name: "sample_solver",
        label: "Sampler",
        type: "enum",
        default: "unipc",
        options: [{ value: "unipc", label: "unipc" }, { value: "dpm++", label: "dpm++" }],
      },
      { name: "sample_guide_scale", label: "Prompt adherence", type: "number", default: 5, min: 0, max: 20, step: 0.1 },
      { name: "sample_shift", label: "Motion strength", type: "int", default: 16, min: 1, max: 30 },
      SEED,
    ],
  },
];

// ───────────────────── Cloudflare Workers AI ─────────────────────
// These run on Cloudflare's GPUs via the AI binding and are billed to the
// Cloudflare account (Workers AI free allowance, then per-neuron) rather than
// to Pruna, so they need no API key. `cfModel` is the Workers AI model id.
//
// Two output shapes exist and the Worker normalises both: newer models return
// JSON `{image: "<base64>"}`, the Stable Diffusion family returns a raw PNG
// stream.

const CF_NEGATIVE = { name: "negative_prompt", label: "Things to avoid", type: "text", default: "" };
const CF_SEED = { name: "seed", label: "Seed", type: "int", default: 0, min: 0, defaultLabel: "random" };

const AURA_2_EN_VOICES = [
  "amalthea", "andromeda", "apollo", "arcas", "aries", "asteria", "athena", "atlas", "aurora", "callista",
  "cora", "cordelia", "delia", "draco", "electra", "harmonia", "helena", "hera", "hermes", "hyperion",
  "iris", "janus", "juno", "jupiter", "luna", "mars", "minerva", "neptune", "odysseus", "ophelia",
  "orion", "orpheus", "pandora", "phoebe", "pluto", "saturn", "thalia", "theia", "vesta", "zeus",
];
const AURA_2_ES_VOICES = ["alvaro", "aquila", "carina", "celeste", "diana", "estrella", "javier", "nestor", "selena", "sirio"];
const AURA_1_VOICES = ["angus", "arcas", "asteria", "athena", "helios", "hera", "luna", "orion", "orpheus", "perseus", "stella", "zeus"];
const voiceOptions = (names) => names.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));

const WORKERS_AI_MODELS = [
  {
    id: "cf-flux-1-schnell",
    cfModel: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 [schnell]",
    group: "Image generation",
    kind: "image",
    blurb: "12B rectified-flow model. Very fast, capped at 8 steps.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "steps", label: "Detail (steps)", type: "int", default: 4, min: 1, max: 8 },
      CF_SEED,
    ],
  },
  {
    id: "cf-flux-2-klein-4b",
    cfModel: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 [klein] 4B",
    group: "Image generation",
    kind: "image",
    multipart: true,
    blurb: "Ultra-fast distilled FLUX.2. Generates and edits; steps fixed at 4.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "input_images", label: "Reference image(s) to edit (optional)", type: "image", maxItems: 4, asArray: true, asBase64: true },
      { name: "width", label: "Width", type: "int", default: 1024, min: 256, max: 2048, step: 32 },
      { name: "height", label: "Height", type: "int", default: 1024, min: 256, max: 2048, step: 32 },
      CF_SEED,
    ],
  },
  {
    id: "cf-flux-2-klein-9b",
    cfModel: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 [klein] 9B",
    group: "Image generation",
    kind: "image",
    multipart: true,
    blurb: "Higher-quality Klein variant. Generates and edits from references.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "input_images", label: "Reference image(s) to edit (optional)", type: "image", maxItems: 4, asArray: true, asBase64: true },
      { name: "steps", label: "Detail (steps)", type: "int", default: 4, min: 1, max: 50 },
      { name: "width", label: "Width", type: "int", default: 1024, min: 256, max: 2048, step: 32 },
      { name: "height", label: "Height", type: "int", default: 1024, min: 256, max: 2048, step: 32 },
      CF_SEED,
    ],
  },
  {
    id: "cf-flux-2-dev",
    cfModel: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 [dev]",
    group: "Image generation",
    kind: "image",
    multipart: true,
    blurb: "Full FLUX.2 dev — most detailed, multi-reference. Priciest per step.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "input_images", label: "Reference image(s) to edit (optional)", type: "image", maxItems: 4, asArray: true, asBase64: true },
      { name: "steps", label: "Detail (steps)", type: "int", default: 28, min: 1, max: 50 },
      { name: "width", label: "Width", type: "int", default: 1024, min: 256, max: 2048, step: 32 },
      { name: "height", label: "Height", type: "int", default: 1024, min: 256, max: 2048, step: 32 },
      CF_SEED,
    ],
  },
  {
    id: "cf-lucid-origin",
    cfModel: "@cf/leonardo/lucid-origin",
    label: "Leonardo Lucid Origin",
    group: "Image generation",
    kind: "image",
    blurb: "Strong prompt adherence and legible text; wide style range.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 4.5, min: 0, max: 10, step: 0.1 },
      { name: "steps", label: "Detail (steps)", type: "int", default: 25, min: 1, max: 40 },
      { name: "width", label: "Width", type: "int", default: 1120, min: 256, max: 2500, step: 8 },
      { name: "height", label: "Height", type: "int", default: 1120, min: 256, max: 2500, step: 8 },
      CF_SEED,
    ],
  },
  {
    id: "cf-phoenix-1",
    cfModel: "@cf/leonardo/phoenix-1.0",
    label: "Leonardo Phoenix 1.0",
    group: "Image generation",
    kind: "image",
    blurb: "Exceptional prompt adherence and coherent text rendering.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      CF_NEGATIVE,
      { name: "guidance", label: "Prompt adherence", type: "number", default: 2, min: 0, max: 10, step: 0.1 },
      { name: "steps", label: "Detail (steps)", type: "int", default: 25, min: 1, max: 50 },
      { name: "width", label: "Width", type: "int", default: 1024, min: 256, max: 2048, step: 8 },
      { name: "height", label: "Height", type: "int", default: 1024, min: 256, max: 2048, step: 8 },
      CF_SEED,
    ],
  },
  {
    id: "cf-sdxl-base",
    cfModel: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    label: "Stable Diffusion XL Base 1.0",
    group: "Image generation",
    kind: "image",
    blurb: "The classic SDXL base model.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      CF_NEGATIVE,
      { name: "num_steps", label: "Detail (steps)", type: "int", default: 20, min: 1, max: 20 },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 7.5, min: 0, max: 20, step: 0.1 },
      { name: "width", label: "Width", type: "int", default: 1024, min: 256, max: 2048, step: 8 },
      { name: "height", label: "Height", type: "int", default: 1024, min: 256, max: 2048, step: 8 },
      CF_SEED,
    ],
  },
  {
    id: "cf-sdxl-lightning",
    cfModel: "@cf/bytedance/stable-diffusion-xl-lightning",
    label: "Stable Diffusion XL Lightning",
    group: "Image generation",
    kind: "image",
    blurb: "Lightning-fast 1024px SDXL variant.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      CF_NEGATIVE,
      { name: "num_steps", label: "Detail (steps)", type: "int", default: 20, min: 1, max: 20 },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 7.5, min: 0, max: 20, step: 0.1 },
      { name: "width", label: "Width", type: "int", default: 1024, min: 256, max: 2048, step: 8 },
      { name: "height", label: "Height", type: "int", default: 1024, min: 256, max: 2048, step: 8 },
      CF_SEED,
    ],
  },
  {
    id: "cf-dreamshaper-8",
    cfModel: "@cf/lykon/dreamshaper-8-lcm",
    label: "DreamShaper 8 LCM",
    group: "Image generation",
    kind: "image",
    blurb: "SD fine-tune tuned for photorealism without losing range.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      CF_NEGATIVE,
      { name: "num_steps", label: "Detail (steps)", type: "int", default: 20, min: 1, max: 20 },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 7.5, min: 0, max: 20, step: 0.1 },
      { name: "width", label: "Width", type: "int", default: 512, min: 256, max: 2048, step: 8 },
      { name: "height", label: "Height", type: "int", default: 512, min: 256, max: 2048, step: 8 },
      CF_SEED,
    ],
  },
  // cf-sd15-img2img (@cf/runwayml/stable-diffusion-v1-5-img2img) was removed on
  // 2026-09-23: the account gets "403 / 5018: This account is not allowed to
  // access" it, and it is gone from Cloudflare's model catalogue. It took
  // image_b64, prompt, negative_prompt, strength (0-1, default 1), num_steps
  // (max 20), guidance (7.5) and seed, and was listed at $0.00 per step.
  {
    id: "cf-sd15-inpainting",
    cfModel: "@cf/runwayml/stable-diffusion-v1-5-inpainting",
    label: "Stable Diffusion v1.5 Inpainting",
    // Filed with the other Workers AI image models: with img2img gone it was
    // the only Workers AI entry under Image editing. `edits` keeps the reuse
    // button calling its image the thing being edited, as that group would.
    group: "Image generation",
    edits: true,
    kind: "image",
    blurb: "Repaint only the masked area. White in the mask = repaint.",
    fields: [
      { name: "image_b64", label: "Image to edit", type: "image", required: true, asBase64: true },
      { name: "mask_b64", label: "Mask (white = repaint)", type: "image", required: true, asBase64: true },
      { name: "prompt", label: "What to paint there", type: "textarea", required: true },
      CF_NEGATIVE,
      { name: "num_steps", label: "Detail (steps)", type: "int", default: 20, min: 1, max: 20 },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 7.5, min: 0, max: 20, step: 0.1 },
      CF_SEED,
    ],
  },
  // ── Text to speech ──
  // Voice lists are the `speaker` enums in each model's input schema on
  // developers.cloudflare.com. Output is MP3 for all four; the Worker returns it
  // as a data: URI like the image models. Aura-2 English leads the group so it
  // is the default wherever a TTS model is picked.
  {
    id: "cf-aura-2-en",
    cfModel: "@cf/deepgram/aura-2-en",
    label: "Aura-2 English",
    group: "Audio",
    kind: "audio",
    blurb: "Deepgram text-to-speech with context-aware pacing, expression and fillers.",
    fields: [
      { name: "text", label: "Text to speak", type: "textarea", required: true },
      { name: "speaker", label: "Voice", type: "enum", default: "luna", options: voiceOptions(AURA_2_EN_VOICES) },
    ],
  },
  {
    id: "cf-aura-2-es",
    cfModel: "@cf/deepgram/aura-2-es",
    label: "Aura-2 Spanish",
    group: "Audio",
    kind: "audio",
    blurb: "Aura-2 with Spanish voices.",
    fields: [
      { name: "text", label: "Text to speak", type: "textarea", required: true },
      { name: "speaker", label: "Voice", type: "enum", default: "aquila", options: voiceOptions(AURA_2_ES_VOICES) },
    ],
  },
  {
    id: "cf-aura-1",
    cfModel: "@cf/deepgram/aura-1",
    label: "Aura-1",
    group: "Audio",
    kind: "audio",
    blurb: "The earlier Aura generation, at half Aura-2's rate.",
    fields: [
      { name: "text", label: "Text to speak", type: "textarea", required: true },
      { name: "speaker", label: "Voice", type: "enum", default: "angus", options: voiceOptions(AURA_1_VOICES) },
    ],
  },
  // MeloTTS (@cf/myshell-ai/melotts) is documented but not offered. On
  // 2026-09-23 every call — through the binding and the REST API, with and
  // without `lang`, on the documented minimal input {prompt} — failed with
  // "500 / 3043: Internal server error". Restore this entry once it answers;
  // the Worker already unwraps its JSON {audio} shape, the voice panel already
  // shows a language box for a model with a `lang` field, and its rate stays
  // in CF_NEURONS below.
  //   { id: "cf-melotts", cfModel: "@cf/myshell-ai/melotts", label: "MeloTTS",
  //     group: "Audio", kind: "audio",
  //     blurb: "Multilingual text-to-speech by MyShell. One voice per language; far cheaper than Aura.",
  //     fields: [
  //       { name: "prompt", label: "Text to speak", type: "textarea", required: true },
  //       // Cloudflare gives 'en' and 'fr' as examples but publishes no list.
  //       { name: "lang", label: "Language code", type: "text", default: "en", help: "e.g. en, fr" },
  //     ] },
];

for (const m of WORKERS_AI_MODELS) m.provider = "workers-ai";
for (const m of MODELS) m.provider = "pruna";
MODELS.push(...WORKERS_AI_MODELS);

// ───────────────────────── Pricing ─────────────────────────
// Published Pruna list prices, used only for a client-side *estimate*. Pruna's
// API exposes no balance/credits endpoint, so the app cannot show a real
// remaining balance — only what a run is expected to cost.
//   flat       — usd per image output (multiplied by num_outputs where it applies)
//   per_second — usd per second of output video, keyed by resolution
//   variable   — Pruna lists it as "priced by multiple properties"; not estimable
const PRICING = {
  "p-image": { type: "flat", usd: 0.005 },
  "p-image-rmbg": { type: "flat", usd: 0.005 },
  "p-image-edit": { type: "flat", usd: 0.01 },
  "p-image-edit-lora": { type: "flat", usd: 0.01 },
  // Routed by what the model finds in the image, so the rate is only known
  // after the run. Both ends are published, so the range can at least be shown.
  "p-image-edit-text-aware": { type: "routed_text", usd: { noText: 0.01, text: 0.03 } },
  "flux-dev": { type: "flat", usd: 0.005 },
  "flux-2-klein-4b": { type: "flat", usd: 0.0001 },
  "wan-image-small": { type: "flat", usd: 0.005 },
  "qwen-image": { type: "flat", usd: 0.025 },
  "qwen-image-fast": { type: "flat", usd: 0.005 },
  "z-image-turbo": { type: "flat", usd: 0.005 },
  "z-image-turbo-small": { type: "flat", usd: 0.0025 },
  "qwen-image-edit-plus": { type: "flat", usd: 0.03 },
  "p-video-animate": { type: "per_second", usd: { "720p": 0.03, "1080p": 0.06 } },
  "p-video-replace": { type: "per_second", usd: { "720p": 0.03, "1080p": 0.06 } },
  // Priced by resolution x draft mode: draft is roughly a quarter of full price.
  "p-video": {
    type: "per_second_draft",
    usd: {
      "720p": { normal: 0.02, draft: 0.005 },
      "1080p": { normal: 0.04, draft: 0.01 },
    },
  },
  // Same shape as p-video, at roughly a 25% premium, and the length may be
  // left to the model — in which case there is nothing to multiply and no
  // estimate is shown until the run reports its own length.
  "p-video-2": {
    type: "per_second_draft",
    usd: {
      "720p": { normal: 0.025, draft: 0.015 },
      "1080p": { normal: 0.05, draft: 0.03 },
    },
  },
  // One rate at every resolution — the model exposes no resolution setting.
  "p-video-infiniteworlds": { type: "per_second_flat", usd: 0.01 },
  // Per second of *output* video, with a single draft discount and no
  // resolution tiers — unlike p-video above. There is no duration field
  // either: the output is as long as the source, so the estimate comes from
  // the source clip's own duration, probed client-side when it is picked.
  "p-video-edit": { type: "video_second_draft", usd: { normal: 0.045, draft: 0.025 } },
  // Priced in tiers by target output megapixels, not a flat per-image rate.
  "p-image-upscale": {
    type: "mp_tiered",
    tiers: [
      { max: 4, usd: 0.005 },
      { max: 8, usd: 0.01 },
      { max: 16, usd: 0.02 },
      { max: 32, usd: 0.04 },
      { max: 64, usd: 0.06 },
      { max: 128, usd: 0.12 },
    ],
  },
  // Priced by thinking effort x output resolution budget.
  "p-image-ideogram": {
    type: "thinking_size_tiered",
    usd: {
      "very low": { "1K": 0.003, "2K": 0.006 },
      low: { "1K": 0.0075, "2K": 0.015 },
      medium: { "1K": 0.01, "2K": 0.02 },
      high: { "1K": 0.015, "2K": 0.03 },
    },
  },
  "p-image-try-on": { type: "variable" },
  "p-try-on-glasses": { type: "flat", usd: 0.02 },
  "p-video-avatar": { type: "variable" },
  "vace": { type: "variable" },
  "wan-t2v": { type: "variable" },
  // Flat per video, not per second: $0.05 at 480p, $0.11 at 720p.
  "wan-i2v": { type: "flat_by_resolution", usd: { "480p": 0.05, "720p": 0.11 } },
  // Trainers are billed by training step, not per output. Rates from Pruna's
  // models page; both are async-only and their output expires ~30 min after
  // the job finishes.
  "p-image-trainer": { type: "per_1k_steps", usd: 1.8 },
  "p-image-edit-trainer": { type: "per_1k_steps", usd: 4.0 },
};

// Workers AI is billed in "neurons" against a 10,000/day free allowance, with
// a different shape per model. Published rates, used for a client-side estimate:
//   perTile / perStep       — neurons per 512x512 output tile, and per step
//   perOutputTile/perInputTile — flat per-tile (no step component)
//   perFirstMp/perExtraMp   — per megapixel, first MP charged higher
// Models absent from Cloudflare's pricing table are left unpriced rather than
// guessed at.
export const CF_FREE_NEURONS_PER_DAY = 10000;

const CF_NEURONS = {
  "cf-flux-1-schnell": { perTile: 4.8, perStep: 9.6 },
  "cf-flux-2-dev": { perOutputTilePerStep: 37.5, perInputTilePerStep: 18.75 },
  "cf-lucid-origin": { perTile: 636, perStep: 12 },
  "cf-phoenix-1": { perTile: 530, perStep: 10 },
  "cf-flux-2-klein-4b": { perOutputTile: 26.05, perInputTile: 5.37 },
  "cf-flux-2-klein-9b": { perFirstMp: 1363.64, perExtraMp: 181.82, perInputMp: 181.82 },
  // Cloudflare lists these at $0.00 per step, so there is no per-image charge
  // to estimate. That is NOT the same as unlimited: verified against the API,
  // once the account's daily neuron allowance is spent these return
  // "429 / 4006: you have used up your daily free allocation" exactly like the
  // metered models. The allowance gate is account-wide, not per model.
  "cf-sdxl-base": { free: true },
  "cf-sdxl-lightning": { free: true },
  "cf-sd15-inpainting": { free: true },
  // dreamshaper-8-lcm has no published rate at all — left unpriced.
  // Text to speech, converted from the listed dollar rates at $0.011 per 1,000
  // neurons: Aura-2 $0.03 and Aura-1 $0.015 per 1,000 characters, MeloTTS
  // $0.000205 per minute of audio.
  "cf-aura-2-en": { perKChars: 2727.27 },
  "cf-aura-2-es": { perKChars: 2727.27 },
  "cf-aura-1": { perKChars: 1363.64 },
  "cf-melotts": { perAudioMin: 18.64 },
};

// USD per neuron beyond the free daily allowance ($0.011 per 1,000).
export const CF_USD_PER_NEURON = 0.011 / 1000;

const XAI_PRICING = {
  // Published xAI list prices: output per image, plus a per-reference-image
  // input charge. Text input is free.
  "xai-imagine-image": { type: "flat", usd: 0.02, inputUsd: 0.002 },
  "xai-imagine-image-quality": { type: "flat", usd: 0.05, usd2k: 0.07, inputUsd: 0.01 },
  // Published xAI list prices: output per image, tiered by resolution and
  // quality, plus a per-reference-image input charge.
  "xai-imagine-image-2": {
    type: "res_quality_tiered",
    usd: { "1k": { low: 0.04, medium: 0.06 }, "2k": { low: 0.06, medium: 0.08 } },
    inputUsd: 0.01,
  },
  // Video is priced two ways depending on the mode. Generating: output per
  // second by resolution, plus a per-input-image charge for the start image and
  // any reference images. Editing or extending: the source video is charged per
  // second to read, and the output runs at the generation rate for whichever
  // resolution bucket the source falls into — neither of which the Worker sees
  // before upload, so the frontend probes the chosen file client-side (duration
  // and height only, nothing uploaded) and shows no estimate until one is
  // picked. 1.0 publishes no 1080p rate, so that tier is left out and priced as
  // "varies" rather than guessed at.
  "xai-imagine-video": {
    type: "xai_video",
    outUsdPerSec: { "480p": 0.05, "720p": 0.07 },
    inputImageUsd: 0.002,
    sourceUsdPerSec: 0.01,
  },
  // 1.5 publishes a 1080p rate where 1.0 does not, and charges more per second
  // across the board. Input images are $0.01 each rather than $0.002.
  "xai-imagine-video-1-5": {
    type: "xai_video",
    outUsdPerSec: { "480p": 0.08, "720p": 0.14, "1080p": 0.25 },
    inputImageUsd: 0.01,
    sourceUsdPerSec: 0.01,
  },
};

for (const m of MODELS) {
  if (m.provider === "workers-ai") {
    m.price = CF_NEURONS[m.id] ? { type: "cf_neurons", ...CF_NEURONS[m.id] } : { type: "cf_unpriced" };
  } else {
    m.price = PRICING[m.id] || { type: "variable" };
  }
}

// Chat models offered for the "Improve" button. Grouped by family and ordered
// by size within it, so the list reads as a catalogue rather than a price
// ladder; the cost is shown once a model is picked instead of in its name.
// `neurons` is the rough cost of one rewrite (~120 input + ~200 output tokens)
// at Cloudflare's published per-million-token rates.
//
// Exception: the entries added on 2026-09-23 (DeepSeek V4, Gemma 4, GLM 5.x,
// Kimi, Llama 3.1 8B FP8, Qwen 3.8, SEA-LION) carry the `usage.neurons` one live
// rewrite actually reported. Their reasoning tokens bill as output, so the
// nominal figure undercounted them by up to 5x (GLM 5.3: ~95 nominal, 508 real).
// Reasoning length varies from run to run; treat these as typical, not fixed.
//
// Per-model request knobs, all verified against the live API on that date:
//   paid       — needs the Workers Paid plan (or prepaid AI Gateway credits);
//                Cloudflare lists exactly these seven in its pricing docs
//   thinking   — false sends chat_template_kwargs.enable_thinking=false. Kimi
//                K2.6 and Gemma 4 otherwise spent the whole 1,500-token budget
//                thinking and returned null content (finish_reason "length")
//   effort     — sent as reasoning_effort. GLM 5.3 at its default effort used
//                1,238 of 1,500 tokens on a one-line rewrite; "low" used 33
//   maxTokens  — overrides the reasoning/non-reasoning default budget
export const IMPROVE_MODELS = [
  { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", family: "DeepSeek", label: "DeepSeek R1 Distill Qwen 32B", neurons: 94.2, reasoning: true },
  { id: "@cf/deepseek-ai/deepseek-v4-flash-0731", family: "DeepSeek", label: "DeepSeek V4 Flash (0731)", neurons: 19.6, reasoning: true, paid: true },
  { id: "@cf/deepseek-ai/deepseek-v4-pro-0813", family: "DeepSeek", label: "DeepSeek V4 Pro (0813)", neurons: 101.8, reasoning: true, paid: true },
  { id: "@cf/google/gemma-4-26b-a4b-it", family: "Gemma", label: "Gemma 4 26B A4B IT", neurons: 1.5, thinking: false },
  { id: "@cf/zai-org/glm-4.7-flash", family: "GLM", label: "GLM 4.7 Flash", neurons: 7.9, reasoning: true },
  { id: "@cf/zai-org/glm-5.3-flash", family: "GLM", label: "GLM 5.3 Flash", neurons: 18.8, reasoning: true, paid: true },
  { id: "@cf/zai-org/glm-5.2", family: "GLM", label: "GLM 5.2", neurons: 213, reasoning: true, paid: true },
  { id: "@cf/zai-org/glm-5.3", family: "GLM", label: "GLM 5.3", neurons: 26.2, reasoning: true, paid: true, effort: "low" },
  { id: "@cf/openai/gpt-oss-20b", family: "GPT-OSS", label: "GPT-OSS 20B", neurons: 7.7, reasoning: true },
  { id: "@cf/openai/gpt-oss-120b", family: "GPT-OSS", label: "GPT-OSS 120B", neurons: 17.5, reasoning: true },
  { id: "@cf/ibm-granite/granite-4.0-h-micro", family: "Granite", label: "Granite 4.0 H Micro", neurons: 2.2 },
  { id: "@cf/moonshotai/kimi-k2.6", family: "Kimi", label: "Kimi K2.6", neurons: 199, reasoning: true, paid: true, thinking: false },
  { id: "@cf/moonshotai/kimi-k2.7-code", family: "Kimi", label: "Kimi K2.7 Code", neurons: 187, reasoning: true, paid: true },
  { id: "@cf/meta/llama-3.2-1b-instruct", family: "Llama", label: "Llama 3.2 1B Instruct", neurons: 3.9 },
  { id: "@cf/meta/llama-3.2-3b-instruct", family: "Llama", label: "Llama 3.2 3B Instruct", neurons: 6.6 },
  // -fp8-fast answered as `llama-3.1-8b-fast-v2` on 2026-09-23 (the reply's
  // own `model` field), so the entry names what actually runs.
  { id: "@cf/meta/llama-3.1-8b-fast-v2", family: "Llama", label: "Llama 3.1 8B Fast v2", neurons: 7.5 },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", family: "Llama", label: "Llama 3.1 8B Instruct FP8", neurons: 2.3 },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", family: "Llama", label: "Llama 4 Scout 17B 16E Instruct", neurons: 18.4 },
  { id: "@cf/meta/llama-3.1-70b-instruct-fp8-fast", family: "Llama", label: "Llama 3.1 70B Instruct FP8 Fast", neurons: 44.2 },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", family: "Llama", label: "Llama 3.3 70B Instruct FP8 Fast", neurons: 44.2 },
  // -v0.1 answered as `mistral-7b-instruct-v0.2-lora` on 2026-09-23, so this is
  // the model that was running all along, under its own name. It also takes
  // LoRA adapters.
  // No published rate; 0.09 neurons measured for one rewrite on 2026-09-23.
  { id: "@cf/mistral/mistral-7b-instruct-v0.2-lora", family: "Mistral", label: "Mistral 7B Instruct v0.2", neurons: 0.1 },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", family: "Mistral", label: "Mistral Small 3.1 24B Instruct", neurons: 13.9 },
  { id: "@cf/nvidia/nemotron-3-120b-a12b", family: "Nemotron", label: "Nemotron 3 120B A12B", neurons: 32.7, reasoning: true },
  { id: "@cf/qwen/qwen3-30b-a3b-fp8", family: "Qwen", label: "Qwen3 30B A3B FP8", neurons: 6.6, reasoning: true },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", family: "Qwen", label: "Qwen2.5 Coder 32B Instruct", neurons: 25.4 },
  { id: "@cf/qwen/qwen3.8-27b", family: "Qwen", label: "Qwen3.8 27B", neurons: 119.6, reasoning: true },
  { id: "@cf/qwen/qwq-32b", family: "Qwen", label: "QwQ 32B", neurons: 25.4, reasoning: true },
  // Neither publishes a rate. Measured on 2026-09-23, one rewrite each: Gemma
  // 2B billed 93 neurons for 93 tokens (about 1 per token); Gemma 7B reported
  // 0, and ignored the rewrite instruction to write 304 tokens of its own.
  // Gemma's chat format has no system role. Sent one, Gemma 7B ignored the
  // Improve instruction and explained the prompt's phrases as a bulleted list
  // (2026-09-24); with the instruction folded into the user message it
  // rewrites. `noSystem` makes the Worker do that fold.
  { id: "@cf/google/gemma-2b-it-lora", family: "Gemma", label: "Gemma 2B IT", neurons: 93, noSystem: true },
  { id: "@cf/google/gemma-7b-it-lora", family: "Gemma", label: "Gemma 7B IT", neurons: 0, noSystem: true },
  { id: "@cf/aisingapore/gemma-sea-lion-v4-27b-it", family: "SEA-LION", label: "Gemma SEA-LION v4 27B IT", neurons: 4.2 },
];

// ───────────────────────── xAI (Grok Imagine) ─────────────────────────
// Called directly against api.x.ai with XAI_API_KEY, not through Cloudflare.
// No reference images -> POST /v1/images/generations
// With reference images -> POST /v1/images/edits (up to 3, as data URIs)
// Text input is free; billing is per image, so `price` is a flat USD figure.

const XAI_AR = [
  { value: "auto", label: "Auto (model decides)" },
  { value: "1:1", label: "1:1 square" },
  { value: "16:9", label: "16:9 landscape" },
  { value: "9:16", label: "9:16 portrait" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
  { value: "2:1", label: "2:1 ultrawide" },
  { value: "1:2", label: "1:2" },
  { value: "19.5:9", label: "19.5:9 (wide phone)" },
  { value: "9:19.5", label: "9:19.5 (tall phone)" },
  { value: "20:9", label: "20:9 (wide phone)" },
  { value: "9:20", label: "9:20 (tall phone)" },
];

// Video's documented aspect ratios are a smaller, distinct set from images'
// (no "auto", no phone ratios).
const XAI_VIDEO_AR = [
  { value: "16:9", label: "16:9 landscape" },
  { value: "9:16", label: "9:16 portrait" },
  { value: "1:1", label: "1:1 square" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
];

// The video field type reuses "image" with accept="video/*" and asDataUri,
// the same pattern Pruna's video-input models already use.
function xaiVideoInputField(label) {
  return { name: "video", label, type: "image", accept: "video/*", required: true, asDataUri: true };
}

const XAI_MODELS = [
  {
    id: "xai-imagine-image",
    xaiModel: "grok-imagine-image",
    label: "Grok Imagine Image",
    group: "Image generation",
    kind: "image",
    blurb: "Grok's fast image model. Generates, or edits up to 3 reference images.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "images", label: "Reference image(s) to edit (optional)", type: "image", maxItems: 3, asArray: true, asDataUri: true },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "1k",
        options: [
          { value: "1k", label: "1K (1024×1024)" },
          { value: "2k", label: "2K (2048×2048)" },
        ],
      },
      { name: "aspect_ratio", label: "Aspect ratio", type: "enum", default: "auto", options: XAI_AR },
      { name: "n", label: "How many images", type: "int", default: 1, min: 1, max: 4 },
    ],
  },
  {
    id: "xai-imagine-image-quality",
    xaiModel: "grok-imagine-image-quality",
    label: "Grok Imagine Image Quality",
    group: "Image generation",
    kind: "image",
    blurb: "Higher-quality Grok image model. Generates, or edits up to 3 references.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "images", label: "Reference image(s) to edit (optional)", type: "image", maxItems: 3, asArray: true, asDataUri: true },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "1k",
        options: [
          { value: "1k", label: "1K (1024×1024)" },
          { value: "2k", label: "2K (2048×2048)" },
        ],
      },
      { name: "aspect_ratio", label: "Aspect ratio", type: "enum", default: "auto", options: XAI_AR },
      { name: "n", label: "How many images", type: "int", default: 1, min: 1, max: 4 },
    ],
  },
  {
    id: "xai-imagine-image-2",
    xaiModel: "grok-imagine-image-2.0",
    label: "Grok Imagine Image 2.0",
    group: "Image generation",
    kind: "image",
    blurb: "Newer Grok image model with a quality dial. Generates, or edits up to 3 references.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "images", label: "Reference image(s) to edit (optional)", type: "image", maxItems: 3, asArray: true, asDataUri: true },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "1k",
        options: [
          { value: "1k", label: "1K (1024×1024)" },
          { value: "2k", label: "2K (2048×2048)" },
        ],
      },
      { name: "aspect_ratio", label: "Aspect ratio", type: "enum", default: "auto", options: XAI_AR },
      { name: "n", label: "How many images", type: "int", default: 1, min: 1, max: 4 },
      {
        name: "quality",
        label: "Quality",
        type: "enum",
        default: "medium",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
        ],
      },
    ],
  },
];

// Grok Imagine Video is one model reached through three endpoints:
// /v1/videos/generations, /videos/edits and /videos/extensions. Those were
// previously three catalogue entries with invented names ("Grok Video Edit"),
// which read as separate models xAI does not publish. They are now a mode
// switch on the model itself, and `mode` picks the endpoint at request time.
//
// Fields carry showWhen so each mode shows only what its endpoint accepts:
// editing ignores duration, resolution and aspect ratio entirely (the output
// inherits them from the source video, capped at 720p), and extension's
// duration means something different — the length of the *added* footage,
// 2-10s, not the total.
const XAI_VIDEO_MODES = [
  { value: "generations", label: "Generate a new video" },
  { value: "edits", label: "Edit an existing video" },
  { value: "extensions", label: "Extend an existing video" },
];

// Preset voices, shared with the TTS API. Only grok-imagine-video-1.5 accepts
// them. Caller-supplied audio clips are restricted to trusted partners, so only
// the presets are offered here.
const XAI_VOICES = [
  { value: "", label: "None" },
  { value: "ara", label: "Ara" },
  { value: "carina", label: "Carina" },
  { value: "eve", label: "Eve" },
  { value: "iris", label: "Iris" },
  { value: "liora", label: "Liora" },
  { value: "ursa", label: "Ursa" },
];

const GEN_ONLY = { field: "mode", is: ["generations"] };
const SOURCE_ONLY = { field: "mode", is: ["edits", "extensions"] };

function xaiVideoModel({ id, xaiModel, label, blurb, resolutions, voices }) {
  return {
    id,
    xaiModel,
    xaiEndpoint: "generations", // fallback; `mode` overrides per request
    xaiAsync: true,
    xaiModal: true,
    label,
    group: "Video",
    kind: "video",
    blurb,
    fields: [
      { name: "mode", label: "Mode", type: "enum", required: true, default: "generations", options: XAI_VIDEO_MODES },
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      {
        ...xaiVideoInputField("Source video"),
        showWhen: SOURCE_ONLY,
        help: "MP4, encoded with a codec MP4 supports (H.264, H.265, AV1).",
      },
      {
        name: "image",
        label: "Starting image (optional, for image-to-video)",
        type: "image",
        asDataUri: true,
        showWhen: GEN_ONLY,
        help: "Locks the first frame. To guide the video without locking it, use reference images instead.",
      },
      {
        name: "reference_images",
        label: "Reference image(s) (optional, for reference-to-video)",
        type: "image",
        maxItems: 3,
        asArray: true,
        asDataUri: true,
        showWhen: GEN_ONLY,
        help: 'Guides people, objects or clothing without locking the first frame. Refer to them in the prompt as <IMAGE_1>, <IMAGE_2>, <IMAGE_3>.',
      },
      ...(voices
        ? [
            {
              name: "reference_voice",
              label: "Voice (optional)",
              type: "enum",
              default: "",
              options: XAI_VOICES,
              showWhen: GEN_ONLY,
              help: "Gives the subject a preset voice. Refer to it in the prompt as <AUDIO_0>.",
            },
          ]
        : []),
      { name: "duration", label: "Length (seconds)", type: "int", default: 8, min: 1, max: 15, showWhen: GEN_ONLY },
      {
        name: "extend_duration",
        label: "Length of the new footage (seconds)",
        type: "int",
        default: 6,
        min: 2,
        max: 10,
        showWhen: { field: "mode", is: ["extensions"] },
        help: "Added on top of the source video's own length, not the total.",
      },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "480p",
        options: resolutions,
        showWhen: GEN_ONLY,
      },
      { name: "aspect_ratio", label: "Aspect ratio", type: "enum", default: "16:9", options: XAI_VIDEO_AR, showWhen: GEN_ONLY },
    ],
  };
}

XAI_MODELS.push(
  xaiVideoModel({
    id: "xai-imagine-video",
    xaiModel: "grok-imagine-video",
    label: "Grok Imagine Video",
    blurb: "Text-, image- or reference-to-video, plus editing and extending existing video. Async — polls until done.",
    resolutions: [
      { value: "480p", label: "480p" },
      { value: "720p", label: "720p" },
      { value: "1080p", label: "1080p (no published price)" },
    ],
    voices: false,
  }),
  xaiVideoModel({
    id: "xai-imagine-video-1-5",
    xaiModel: "grok-imagine-video-1.5",
    label: "Grok Imagine Video 1.5",
    blurb: "Newer Grok video model, with a published 1080p tier and preset voices. Async — polls until done.",
    resolutions: [
      { value: "480p", label: "480p" },
      { value: "720p", label: "720p" },
      { value: "1080p", label: "1080p" },
    ],
    voices: true,
  }),
);

for (const m of XAI_MODELS) m.provider = "xai";
MODELS.push(...XAI_MODELS);
// Priced here rather than in the loop above, which runs before this push.
for (const m of XAI_MODELS) m.price = XAI_PRICING[m.id] || { type: "variable" };

// Vision models for the "Describe" button (image -> text). Their inputs differ
// enough that the Worker builds each payload separately:
//   llava     takes `image` as a byte array, returns {description}
//   moondream takes `image` as a data URI, streams by default (must disable),
//             and returns {caption} for task="caption"
//   chat      OpenAI-style messages with an image_url content part carrying a
//             data URI; answer in choices[0].message.content. Takes the same
//             thinking / effort / maxTokens knobs as IMPROVE_MODELS.
// Vision models offered for the "Describe" button. As with IMPROVE_MODELS the
// name stands alone and the caveat moves into `note`, shown after selection.
//
// The chat entries' knobs were each settled by live runs on 2026-09-23 against
// a 512px image. At 512 tokens every reasoning model returned null content.
// With thinking off, GLM 5.3 Flash wrote its reasoning into the answer itself,
// so it keeps thinking at low effort instead. Kimi K2.6 is deliberately absent:
// with thinking off and a 4,000-token budget it still hit the limit, after 90s
// and 1,460 neurons — about 15% of the daily free allowance for one caption.
export const DESCRIBE_MODELS = [
  { id: "@cf/llava-hf/llava-1.5-7b-hf", label: "LLaVA 1.5 7B", note: "beta, no listed price" },
  { id: "@cf/moondream/moondream3.1-9B-A2B", label: "Moondream 3.1 9B A2B", note: "richer detail than LLaVA" },
  { id: "@cf/meta/llama-3.2-11b-vision-instruct", label: "Llama 3.2 11B Vision Instruct", note: "the most descriptive of the first three" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B 16E Instruct", chat: true, maxTokens: 1024 },
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B IT", chat: true, thinking: false, maxTokens: 1024 },
  { id: "@cf/qwen/qwen3.8-27b", label: "Qwen3.8 27B", chat: true, thinking: false, maxTokens: 1024 },
  { id: "@cf/zai-org/glm-5.3-flash", label: "GLM 5.3 Flash", chat: true, paid: true, effort: "low", maxTokens: 3072 },
  // Re-checked on 2026-09-23: it now reasons even with thinking off, and at
  // 1,024 tokens spent the whole budget before answering; 2,048 finished.
  { id: "@cf/moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code", chat: true, paid: true, thinking: false, maxTokens: 2048 },
  // Not flagged as vision in Cloudflare's model API, but its catalogue page
  // says it is, and on 2026-09-23 it described the test image correctly.
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B Instruct", chat: true, maxTokens: 1024 },
];

export const DESCRIBE_MODEL_IDS = new Set(DESCRIBE_MODELS.map((m) => m.id));
export const DEFAULT_DESCRIBE_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

// ───────────────────────── p-judger (the "Judge" button) ─────────────────────
// Scores how well an image matches a prompt. It is deliberately NOT in MODELS:
// every entry there produces media through /api/generate -> showResult(), and
// this returns a JSON score object instead. It is a prompt tool like Improve
// and Describe, and runs through its own /api/judge route.
//
// Verified against the live API on 2026-09-08 (four calls: single, batch with a
// shared prompt, batch with per-image prompts, and the async status path). Two
// things differ from Pruna's published docs and are load-bearing here:
//
//   1. `generation_url` is a JSON *object*, not a URL string —
//      {"total": 49.1204} for one image, {"results":[{...},{...}]} for a batch.
//   2. The docs describe a score object "with fields including total, level1,
//      level2, level3, and detailed". Every call returned `total` alone, and
//      there is no parameter that asks for more: the endpoint rejects any
//      undocumented key with "additional properties forbidden". The UI
//      therefore headlines `total` but still shows the whole payload on
//      demand, so any field Pruna adds later surfaces without a code change.
//
// The scale is undocumented. Two runs on the same image scored 49.12 against
// its own prompt and 39.20 against an unrelated one, which fixes the direction
// but not the bounds — so the score is never rendered as a percentage or a bar.
export const JUDGE_MODEL = "p-judger";
export const JUDGE_USD_PER_IMAGE = 0.005;
// Pruna documents no batch limit. This cap is ours: it bounds the per-run cost
// and the number of thumbnails the picker can hand back at once.
export const JUDGE_MAX_IMAGES = 10;

// The model the picker opens on. Editing an image you already have is the
// common case, so it beats generating one from scratch as a starting point.
export const DEFAULT_MODEL = "p-image-edit";

// What each chat model accepts beyond the basics, for the ⚙ settings panel.
// Thinking (chat_template_kwargs.enable_thinking) is from each model's input
// schema via Cloudflare's models/schema API, 2026-09-23. Effort values are the
// `reasoning_effort.supported_efforts` Cloudflare's model list gives per model;
// a value outside it is silently rewritten (GLM 5.3 turns "medium" into
// "max"), so only these are offered. Where the list gives none, the schema's
// own low/medium/high stands. GPT-OSS takes effort in the messages form too,
// verified live: low answered in 20 tokens, high in 80.
const THINKING = [
  "@cf/deepseek-ai/deepseek-v4-flash-0731", "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/google/gemma-4-26b-a4b-it", "@cf/zai-org/glm-4.7-flash", "@cf/zai-org/glm-5.3-flash",
  "@cf/zai-org/glm-5.2", "@cf/zai-org/glm-5.3", "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code", "@cf/qwen/qwen3.8-27b", "@cf/nvidia/nemotron-3-120b-a12b",
];
const SCHEMA_EFFORTS = ["low", "medium", "high"];
const EFFORTS = {
  "@cf/deepseek-ai/deepseek-v4-flash-0731": ["none", "low", "high", "max"],
  "@cf/deepseek-ai/deepseek-v4-pro-0813": ["none", "low", "high", "max"],
  "@cf/google/gemma-4-26b-a4b-it": SCHEMA_EFFORTS,
  "@cf/zai-org/glm-4.7-flash": SCHEMA_EFFORTS,
  "@cf/zai-org/glm-5.3-flash": ["low", "high", "max"],
  "@cf/zai-org/glm-5.2": ["none", "high", "max"],
  "@cf/zai-org/glm-5.3": ["low", "high", "max"],
  "@cf/openai/gpt-oss-20b": SCHEMA_EFFORTS,
  "@cf/openai/gpt-oss-120b": SCHEMA_EFFORTS,
  "@cf/moonshotai/kimi-k2.6": ["none", "high"],
  "@cf/moonshotai/kimi-k2.7-code": SCHEMA_EFFORTS,
  "@cf/qwen/qwen3.8-27b": ["low", "medium", "xhigh"],
};

// Neurons per million output tokens, from Cloudflare's published per-model
// rates. Used to show the most a reply can cost at a given token limit.
const OUT_NEURONS_PER_M = {
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": 443756,
  "@cf/deepseek-ai/deepseek-v4-flash-0731": 120000,
  "@cf/deepseek-ai/deepseek-v4-pro-0813": 360000,
  "@cf/google/gemma-4-26b-a4b-it": 27273,
  "@cf/zai-org/glm-4.7-flash": 36400,
  "@cf/zai-org/glm-5.3-flash": 45455,
  "@cf/zai-org/glm-5.2": 400000,
  "@cf/zai-org/glm-5.3": 400000,
  "@cf/openai/gpt-oss-20b": 27273,
  "@cf/openai/gpt-oss-120b": 68182,
  "@cf/ibm-granite/granite-4.0-h-micro": 10158,
  "@cf/moonshotai/kimi-k2.6": 363636,
  "@cf/moonshotai/kimi-k2.7-code": 363636,
  "@cf/meta/llama-3.2-1b-instruct": 18252,
  "@cf/meta/llama-3.2-3b-instruct": 30475,
  "@cf/meta/llama-3.1-8b-fast-v2": 34868,
  "@cf/meta/llama-3.1-8b-instruct-fp8": 26128,
  "@cf/meta/llama-4-scout-17b-16e-instruct": 77273,
  "@cf/meta/llama-3.1-70b-instruct-fp8-fast": 204805,
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": 204805,
  // Mistral 7B v0.2 and both Gemmas publish no rate, so no maximum is shown.
  "@cf/mistralai/mistral-small-3.1-24b-instruct": 50488,
  "@cf/nvidia/nemotron-3-120b-a12b": 136364,
  "@cf/qwen/qwen3-30b-a3b-fp8": 30475,
  "@cf/qwen/qwen2.5-coder-32b-instruct": 90909,
  "@cf/qwen/qwen3.8-27b": 290909,
  "@cf/qwen/qwq-32b": 90909,
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it": 50488,
};
for (const m of IMPROVE_MODELS) {
  m.canThink = THINKING.includes(m.id);
  m.efforts = EFFORTS[m.id] || null;
  m.outPerM = OUT_NEURONS_PER_M[m.id] || null;
}

export const IMPROVE_MODEL_IDS = new Set(IMPROVE_MODELS.map((m) => m.id));

// The chat under the toolbar talks to the Improve models, since only
// chat-format models can hold a conversation. `vision` marks those that can
// also be handed the attached image: the chat-format Describe entries. LLaVA,
// Moondream and Llama 3.2 Vision take one image and one question with no
// history, so they stay behind Describe for captions.
const CHAT_VISION_IDS = new Set(DESCRIBE_MODELS.filter((m) => m.chat).map((m) => m.id));
export const CHAT_MODELS = IMPROVE_MODELS.map((m) => ({ ...m, vision: CHAT_VISION_IDS.has(m.id) }));
export const CHAT_MODEL_IDS = new Set(CHAT_MODELS.map((m) => m.id));
export const DEFAULT_CHAT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// Text embedding models for the Embeddings panel. Each turns a text into a
// list of numbers placed by meaning; the panel compares those lists. `dims` is
// the list length each returned on 2026-09-23, and `neuronsPerM` is
// Cloudflare's published rate per million input tokens — a prompt is a
// hundred or so tokens, so a measurement costs about a tenth of a neuron.
// Lists from different models cannot be compared, so the panel keeps one
// version history per model.
//
// Request shapes follow each model's documented schema:
//   contexts  bge-m3 documents {contexts: [{text}]}, and answers under
//             `response` rather than `data`
//   pooling   the English BGE models take `pooling`; Cloudflare recommends
//             "cls" for accuracy and warns cls and mean vectors do not mix,
//             so it is fixed here rather than left to the default "mean"
//   qwen3 and plamo take plain `text` (for qwen3, an alias of `documents`,
//   which skips the retrieval `instruction` meant for queries)
export const EMBED_MODELS = [
  { id: "@cf/baai/bge-m3", label: "BGE M3", dims: 1024, neuronsPerM: 1075, contexts: true },
  { id: "@cf/qwen/qwen3-embedding-0.6b", label: "Qwen3 Embedding 0.6B", dims: 1024, neuronsPerM: 1075 },
  { id: "@cf/baai/bge-small-en-v1.5", label: "BGE Small EN v1.5", dims: 384, neuronsPerM: 1841, pooling: "cls" },
  { id: "@cf/baai/bge-base-en-v1.5", label: "BGE Base EN v1.5", dims: 768, neuronsPerM: 6058, pooling: "cls" },
  { id: "@cf/baai/bge-large-en-v1.5", label: "BGE Large EN v1.5", dims: 1024, neuronsPerM: 18582, pooling: "cls" },
  // Beta and absent from the pricing table, so its rate is unknown here.
  { id: "@cf/google/embeddinggemma-300m", label: "EmbeddingGemma 300M", dims: 768, neuronsPerM: null },
  { id: "@cf/pfnet/plamo-embedding-1b", label: "PLaMo Embedding 1B", dims: 2048, neuronsPerM: 1689 },
];
export const EMBED_MODEL_IDS = new Set(EMBED_MODELS.map((m) => m.id));
export const DEFAULT_EMBED_MODEL = "@cf/baai/bge-m3";

// Translate: m2m100 only. Its language list is the `languages` Cloudflare's
// model list gives for it; codes are the ISO 639-1 ones its schema's examples
// use ('en', 'es').
export const TRANSLATE_MODEL = "@cf/meta/m2m100-1.2b";
export const TRANSLATE_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
];

// Speech to text, for the chat's 🎤. Each takes the audio differently, per its
// schema: Whisper and Whisper Tiny a list of byte values, Whisper Large v3
// Turbo base64, Nova-3 a stream with its content type. Deepgram Flux is left
// out: Cloudflare serves it over a WebSocket only.
export const STT_MODELS = [
  { id: "@cf/openai/whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", audio: "base64" },
  { id: "@cf/openai/whisper", label: "Whisper", audio: "bytes" },
  { id: "@cf/openai/whisper-tiny-en", label: "Whisper Tiny EN", audio: "bytes" },
  { id: "@cf/deepgram/nova-3", label: "Deepgram Nova-3", audio: "stream" },
];
export const STT_MODEL_IDS = new Set(STT_MODELS.map((m) => m.id));
export const DEFAULT_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

// The "Other" section: catalogue models that fit no other panel.
export const OTHER_TOOLS = [
  { id: "guard", model: "@cf/meta/llama-guard-3-8b", label: "Safety check · Llama Guard 3 8B", input: "text" },
  { id: "sentiment", model: "@cf/huggingface/distilbert-sst-2-int8", label: "Sentiment · DistilBERT SST-2 INT8", input: "text" },
  { id: "labels", model: "@cf/microsoft/resnet-50", label: "Image labels · ResNet-50", input: "image" },
  { id: "rerank", model: "@cf/baai/bge-reranker-base", label: "Rerank · BGE Reranker Base", input: "rerank" },
];
export const DEFAULT_IMPROVE_MODEL = "@cf/meta/llama-3.2-3b-instruct";

// Allow-list of valid model ids (used by the Worker to reject arbitrary models).
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));
