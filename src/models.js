// Pruna AI model catalog — single source of truth for both the Worker
// (allow-list + /api/models) and the browser UI.
//
// Field schema:
//   name        API input key
//   label       shown in the UI
//   type        text | textarea | int | number | bool | enum | image
//   required    always sent, no enable-toggle (default false)
//   default     value pre-filled when the field is enabled
//   min/max/step numeric bounds (int/number)
//   options     [{value,label}] for enum
//   maxItems    for image arrays (default 1)
//   help        short hint under the field
//
// Optional (non-required) fields render with an "override" toggle so you only
// send the parameters you actually want to change; everything else falls back
// to Pruna's own defaults.
//
// LoRA / trainer parameters are intentionally omitted (not needed here).

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
  label: "Output format",
  type: "enum",
  default: "jpg",
  options: [
    { value: "jpg", label: "jpg" },
    { value: "png", label: "png" },
    { value: "webp", label: "webp" },
  ],
};

const OUTPUT_QUALITY = {
  name: "output_quality",
  label: "Output quality",
  type: "int",
  default: 80,
  min: 0,
  max: 100,
  help: "Ignored for png.",
};

const SEED = {
  name: "seed",
  label: "Seed",
  type: "int",
  default: -1,
  min: -1,
  help: "-1 / blank = random. Reuse a seed to reproduce a result.",
};

const DISABLE_SAFETY = {
  name: "disable_safety_checker",
  label: "Disable safety checker",
  type: "bool",
  default: true,
};

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
        label: "Speed mode (quality vs speed)",
        type: "enum",
        default: "Extra Juiced 🔥 (more speed)",
        options: [
          { value: "Lightly Juiced 🍊 (more consistent)", label: "Lightly Juiced — most consistent" },
          { value: "Juiced 🔥 (default)", label: "Juiced — balanced" },
          { value: "Extra Juiced 🔥 (more speed)", label: "Extra Juiced — faster (default)" },
          { value: "Blink of an eye 👁️", label: "Blink of an eye — fastest" },
        ],
      },
      { name: "num_inference_steps", label: "Steps (quality)", type: "int", default: 28, min: 1, max: 50 },
      { name: "guidance", label: "Guidance", type: "number", default: 3.5, min: 0, max: 20, step: 0.1 },
      { name: "image_size", label: "Image size (longest side)", type: "int", default: 1024, min: 256, max: 2048, step: 16 },
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
      { name: "negative_prompt", label: "Negative prompt", type: "text", default: "" },
      { name: "aspect_ratio", label: "Aspect ratio", type: "enum", default: "16:9", options: AR_COMMON },
      { name: "num_inference_steps", label: "Steps (quality)", type: "int", default: 30, min: 1, max: 50 },
      { name: "guidance", label: "Guidance", type: "number", default: 3, min: 0, max: 10, step: 0.1 },
      { name: "enhance_prompt", label: "Enhance prompt", type: "bool", default: true },
      { name: "go_fast", label: "Go fast", type: "bool", default: true },
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
      { name: "image", label: "Init image (img2img, optional)", type: "image" },
      { name: "strength", label: "img2img strength", type: "number", default: 0.9, min: 0, max: 1, step: 0.05 },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      SEED,
      DISABLE_SAFETY,
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
        options: [...AR_COMMON, { value: "custom", label: "custom (width/height)" }],
      },
      { name: "width", label: "Width (custom AR)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "height", label: "Height (custom AR)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "creativity", label: "Creativity", type: "number", default: 0.62, min: 0, max: 1, step: 0.01 },
      SEED,
      DISABLE_SAFETY,
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
      { name: "num_inference_steps", label: "Steps (quality)", type: "int", default: 8, min: 1, max: 50 },
      { name: "guidance_scale", label: "Guidance scale", type: "number", default: 0, min: 0, max: 20, step: 0.1 },
      { name: "go_fast", label: "Go fast", type: "bool", default: false },
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
        options: [...AR_COMMON, { value: "custom", label: "custom (width/height)" }],
      },
      { name: "width", label: "Width (custom AR)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "height", label: "Height (custom AR)", type: "int", default: 1024, min: 256, max: 1440, step: 16 },
      { name: "prompt_upsampling", label: "Prompt upsampling", type: "bool", default: false },
      SEED,
      DISABLE_SAFETY,
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
      { name: "image", label: "Input image(s)", type: "image", required: true, maxItems: 2, asArray: true },
      { name: "prompt", label: "Edit instruction", type: "textarea", required: true },
      { name: "go_fast", label: "Go fast", type: "bool", default: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "match_input_image",
        options: [
          { value: "match_input_image", label: "Match input image" },
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
      DISABLE_SAFETY,
    ],
  },
  {
    id: "p-image-edit",
    label: "P-Image-Edit (Pruna)",
    group: "Image editing",
    kind: "image",
    blurb: "Compose / edit from 1–5 reference images.",
    fields: [
      { name: "images", label: "Reference image(s)", type: "image", required: true, maxItems: 5, asArray: true },
      { name: "prompt", label: "Edit instruction", type: "textarea", required: true },
      { name: "turbo", label: "Turbo (off for complex edits)", type: "bool", default: true },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "enum",
        default: "match_input_image",
        options: [{ value: "match_input_image", label: "Match input image" }, ...AR_COMMON],
      },
      SEED,
      DISABLE_SAFETY,
    ],
  },
  {
    id: "p-image-upscale",
    label: "P-Image-Upscale (Pruna)",
    group: "Image editing",
    kind: "image",
    blurb: "Upscale an image to a target megapixel count.",
    fields: [
      { name: "image", label: "Input image", type: "image", required: true },
      { name: "target", label: "Target resolution (megapixels)", type: "int", default: 4, min: 1, max: 128 },
      { name: "enhance_details", label: "Enhance details", type: "bool", default: false },
      { name: "enhance_realism", label: "Enhance realism", type: "bool", default: false },
      OUTPUT_FORMAT,
      OUTPUT_QUALITY,
      DISABLE_SAFETY,
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
      { name: "num_frames", label: "Frames (duration)", type: "int", default: 81, min: 81, max: 121 },
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
        options: [{ value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }],
      },
      { name: "frames_per_second", label: "FPS", type: "int", default: 16, min: 5, max: 30 },
      { name: "interpolate_output", label: "Interpolate (smoother)", type: "bool", default: true },
      { name: "go_fast", label: "Go fast", type: "bool", default: true },
      { name: "optimize_prompt", label: "Optimize prompt", type: "bool", default: false },
      { name: "sample_shift", label: "Sample shift", type: "number", default: 12, min: 1, max: 20, step: 0.5 },
      SEED,
      DISABLE_SAFETY,
    ],
  },
  {
    id: "wan-i2v",
    label: "WAN Image-to-Video",
    group: "Video",
    kind: "video",
    blurb: "Animate a still image into a video.",
    fields: [
      { name: "image", label: "Start image", type: "image", required: true },
      { name: "prompt", label: "Prompt", type: "textarea", required: true },
      { name: "num_frames", label: "Frames (duration)", type: "int", default: 81, min: 81, max: 121 },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "480p",
        options: [{ value: "480p", label: "480p" }, { value: "720p", label: "720p" }],
      },
      { name: "frames_per_second", label: "FPS", type: "int", default: 16, min: 5, max: 30 },
      { name: "last_image", label: "End image (optional)", type: "image" },
      { name: "interpolate_output", label: "Interpolate (smoother)", type: "bool", default: false },
      { name: "go_fast", label: "Go fast", type: "bool", default: true },
      { name: "sample_shift", label: "Sample shift", type: "number", default: 12, min: 1, max: 20, step: 0.5 },
      SEED,
      DISABLE_SAFETY,
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
      { name: "image", label: "Start image (image-to-video, optional)", type: "image" },
      { name: "last_frame_image", label: "End image (optional)", type: "image" },
      { name: "audio", label: "Audio track (optional, sets duration)", type: "image", accept: "audio/*" },
      { name: "duration", label: "Duration (seconds)", type: "int", default: 5, min: 1, max: 20 },
      {
        name: "resolution",
        label: "Resolution",
        type: "enum",
        default: "720p",
        options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }],
      },
      {
        name: "fps",
        label: "FPS",
        type: "enum",
        default: "24",
        options: [{ value: 24, label: "24" }, { value: 48, label: "48" }],
      },
      {
        name: "aspect_ratio",
        label: "Aspect ratio (ignored when start image set)",
        type: "enum",
        default: "16:9",
        options: AR_COMMON,
      },
      { name: "draft", label: "Draft (faster preview)", type: "bool", default: false },
      { name: "prompt_upsampling", label: "Prompt upsampling", type: "bool", default: true },
      { name: "save_audio", label: "Keep audio", type: "bool", default: true },
      SEED,
      { name: "disable_safety_filter", label: "Disable safety filter", type: "bool", default: true },
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
      { name: "src_mask", label: "Source mask (optional)", type: "image" },
      {
        name: "size",
        label: "Size",
        type: "enum",
        default: "832*480",
        options: [
          { value: "832*480", label: "832×480 landscape" },
          { value: "480*832", label: "480×832 portrait" },
          { value: "1280*720", label: "1280×720 landscape" },
          { value: "720*1280", label: "720×1280 portrait" },
        ],
      },
      { name: "frame_num", label: "Frames", type: "int", default: 81, min: 1, max: 81 },
      {
        name: "speed_mode",
        label: "Speed mode",
        type: "enum",
        default: "Lightly Juiced 🍊 (more consistent)",
        options: [
          { value: "Lightly Juiced 🍊 (more consistent)", label: "Lightly Juiced — most consistent" },
          { value: "Juiced 🔥 (more speed)", label: "Juiced — faster" },
          { value: "Extra Juiced 🚀 (even more speed)", label: "Extra Juiced — fastest" },
        ],
      },
      { name: "sample_steps", label: "Sample steps (quality)", type: "int", default: 50, min: 1, max: 100 },
      {
        name: "sample_solver",
        label: "Sample solver",
        type: "enum",
        default: "unipc",
        options: [{ value: "unipc", label: "unipc" }, { value: "dpm++", label: "dpm++" }],
      },
      { name: "sample_guide_scale", label: "Guidance scale", type: "number", default: 5, min: 0, max: 20, step: 0.1 },
      { name: "sample_shift", label: "Sample shift", type: "int", default: 16, min: 1, max: 30 },
      SEED,
    ],
  },
];

// Allow-list of valid model ids (used by the Worker to reject arbitrary models).
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));
