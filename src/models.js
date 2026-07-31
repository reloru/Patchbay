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
    id: "p-image-try-on",
    label: "P-Image-Try-On (Pruna)",
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
    id: "p-video-animate",
    label: "P-Video-Animate (Pruna)",
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
    label: "P-Video-Replace (Pruna)",
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
    label: "P-Video-Avatar (Pruna)",
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

const WORKERS_AI_MODELS = [
  {
    id: "cf-flux-1-schnell",
    cfModel: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 schnell",
    group: "Cloudflare Workers AI",
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
    label: "FLUX.2 Klein 4B",
    group: "Cloudflare Workers AI",
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
    label: "FLUX.2 Klein 9B",
    group: "Cloudflare Workers AI",
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
    label: "FLUX.2 dev",
    group: "Cloudflare Workers AI",
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
    group: "Cloudflare Workers AI",
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
    group: "Cloudflare Workers AI",
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
    label: "Stable Diffusion XL 1.0",
    group: "Cloudflare Workers AI",
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
    label: "SDXL Lightning",
    group: "Cloudflare Workers AI",
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
    group: "Cloudflare Workers AI",
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
  {
    id: "cf-sd15-img2img",
    cfModel: "@cf/runwayml/stable-diffusion-v1-5-img2img",
    label: "SD 1.5 Image-to-Image",
    group: "Cloudflare Workers AI",
    kind: "image",
    blurb: "Redraw an existing image from a prompt.",
    fields: [
      { name: "image_b64", label: "Image to edit", type: "image", required: true, asBase64: true },
      { name: "prompt", label: "What to change", type: "textarea", required: true },
      CF_NEGATIVE,
      { name: "strength", label: "How much to change it", type: "number", default: 1, min: 0, max: 1, step: 0.05 },
      { name: "num_steps", label: "Detail (steps)", type: "int", default: 20, min: 1, max: 20 },
      { name: "guidance", label: "Prompt adherence", type: "number", default: 7.5, min: 0, max: 20, step: 0.1 },
      CF_SEED,
    ],
  },
  {
    id: "cf-sd15-inpainting",
    cfModel: "@cf/runwayml/stable-diffusion-v1-5-inpainting",
    label: "SD 1.5 Inpainting",
    group: "Cloudflare Workers AI",
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
  "p-image-edit": { type: "flat", usd: 0.01 },
  "flux-dev": { type: "flat", usd: 0.005 },
  "flux-2-klein-4b": { type: "flat", usd: 0.0001 },
  "wan-image-small": { type: "flat", usd: 0.005 },
  "qwen-image": { type: "flat", usd: 0.025 },
  "qwen-image-fast": { type: "flat", usd: 0.005 },
  "z-image-turbo": { type: "flat", usd: 0.005 },
  "qwen-image-edit-plus": { type: "flat", usd: 0.03 },
  "p-video-animate": { type: "per_second", usd: { "720p": 0.03, "1080p": 0.06 } },
  "p-video-replace": { type: "per_second", usd: { "720p": 0.03, "1080p": 0.06 } },
  "p-image-upscale": { type: "variable" },
  "p-image-try-on": { type: "variable" },
  "p-video": { type: "variable" },
  "p-video-avatar": { type: "variable" },
  "vace": { type: "variable" },
  "wan-t2v": { type: "variable" },
  "wan-i2v": { type: "variable" },
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
  "cf-sd15-img2img": { free: true },
  "cf-sd15-inpainting": { free: true },
  // dreamshaper-8-lcm has no published rate at all — left unpriced.
};

// USD per neuron beyond the free daily allowance ($0.011 per 1,000).
export const CF_USD_PER_NEURON = 0.011 / 1000;

for (const m of MODELS) {
  if (m.provider === "workers-ai") {
    m.price = CF_NEURONS[m.id] ? { type: "cf_neurons", ...CF_NEURONS[m.id] } : { type: "cf_unpriced" };
  } else {
    m.price = PRICING[m.id] || { type: "variable" };
  }
}

// Chat models offered for the "Improve" button, cheapest first. `neurons` is
// the rough cost of one rewrite (~120 input + ~200 output tokens) at
// Cloudflare's published per-million-token rates.
export const IMPROVE_MODELS = [
  { id: "@cf/ibm-granite/granite-4.0-h-micro", label: "Granite 4.0 Micro — cheapest", neurons: 2.2 },
  { id: "@cf/meta/llama-3.2-1b-instruct", label: "Llama 3.2 1B — fast", neurons: 3.9 },
  { id: "@cf/meta/llama-3.2-3b-instruct", label: "Llama 3.2 3B — balanced (default)", neurons: 6.6 },
  { id: "@cf/zai-org/glm-4.7-flash", label: "GLM 4.7 Flash", neurons: 7.9 },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8-fast", label: "Llama 3.1 8B — sharper", neurons: 7.5 },
  { id: "@cf/openai/gpt-oss-20b", label: "GPT-OSS 20B", neurons: 7.7 },
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B", neurons: 6.6 },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 24B", neurons: 13.9 },
  { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B — strongest", neurons: 17.5 },
];

export const IMPROVE_MODEL_IDS = new Set(IMPROVE_MODELS.map((m) => m.id));
export const DEFAULT_IMPROVE_MODEL = "@cf/meta/llama-3.2-3b-instruct";

// Allow-list of valid model ids (used by the Worker to reject arbitrary models).
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));
