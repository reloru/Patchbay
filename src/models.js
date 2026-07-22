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
  default: -1,
  min: -1,
  defaultLabel: "random",
};

// Content moderation filter. The API param disables the safety checker, so we
// present it inverted: filter "On" == param false.
function moderationFilter(name = "disable_safety_checker", apiDefault = false) {
  return { name, label: "Content moderation filter", type: "bool", default: apiDefault, invert: true };
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
    id: "qwen-image",
    label: "Qwen-Image",
    group: "Image generation",
    kind: "image",
    blurb: "Text-to-image with strong text rendering; optional img2img.",
    fields: [
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
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
    id: "p-image",
    label: "P-Image (Pruna)",
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

  // ───────────────────────── Image editing ─────────────────────────
  {
    id: "qwen-image-edit-plus",
    label: "Qwen-Image-Edit Plus",
    group: "Image editing",
    kind: "image",
    blurb: "Edit / transform 1–2 input images from a text instruction.",
    fields: [
      { name: "image", label: "Image(s) to edit", type: "image", required: true, maxItems: 2, asArray: true },
      { name: "prompt", label: "What to change", type: "textarea", required: true },
      { name: "go_fast", label: "Fast mode", type: "bool", default: true },
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
      { ...OUTPUT_QUALITY, default: 95 },
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-image-edit",
    label: "P-Image-Edit (Pruna)",
    group: "Image editing",
    kind: "image",
    blurb: "Compose / edit from 1–5 reference images.",
    fields: [
      { name: "images", label: "Image(s) to edit", type: "image", required: true, maxItems: 5, asArray: true },
      { name: "prompt", label: "What to change", type: "textarea", required: true },
      { name: "turbo", label: "Fast mode (turbo)", type: "bool", default: true },
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
    id: "p-image-upscale",
    label: "P-Image-Upscale (Pruna)",
    group: "Image editing",
    kind: "image",
    blurb: "Upscale an image to a target megapixel count.",
    fields: [
      { name: "image", label: "Image to upscale", type: "image", required: true },
      { name: "target", label: "Target size (megapixels)", type: "int", default: 4, min: 1, max: 128 },
      { name: "enhance_details", label: "Enhance fine details", type: "bool", default: false },
      { name: "enhance_realism", label: "Enhance realism", type: "bool", default: false },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      moderationFilter(),
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
      SEED,
      moderationFilter(),
    ],
  },
  {
    id: "p-video",
    label: "P-Video (Pruna)",
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
        name: "fps",
        label: "Frames per second",
        type: "enum",
        default: "24",
        options: [{ value: 24, label: "24" }, { value: 48, label: "48" }],
      },
      {
        name: "aspect_ratio",
        label: "Aspect ratio (ignored with a start image)",
        type: "enum",
        default: "16:9",
        options: AR_COMMON,
      },
      { name: "draft", label: "Draft mode (faster preview)", type: "bool", default: false },
      { name: "prompt_upsampling", label: "Auto-improve prompt", type: "bool", default: true },
      { name: "save_audio", label: "Keep audio", type: "bool", default: true },
      SEED,
      moderationFilter("disable_safety_filter", true),
    ],
  },
  {
    id: "vace",
    label: "VACE (reference-to-video)",
    group: "Video",
    kind: "video",
    blurb: "Character-consistent video from a prompt + reference images/video/mask.",
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

// Allow-list of valid model ids (used by the Worker to reject arbitrary models).
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));
