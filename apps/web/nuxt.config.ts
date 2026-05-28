// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: true,
  compatibilityDate: "2026-05-27",

  modules: ["@pinia/nuxt", "@nuxtjs/tailwindcss"],

  app: {
    head: {
      title: "Airport Inspection Platform",
      htmlAttrs: { class: "dark" },
      bodyAttrs: { class: "bg-aip-base text-aip-fg antialiased" },
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        {
          name: "description",
          content: "Operations dashboard for the Airport Inspection Platform demo.",
        },
      ],
    },
  },

  css: ["~/assets/css/tailwind.css"],

  runtimeConfig: {
    public: {
      apiBaseUrl: process.env["NUXT_PUBLIC_API_BASE_URL"] ?? "/api/v1",
      wsBaseUrl: process.env["NUXT_PUBLIC_WS_BASE_URL"] ?? "/ws/v1",
    },
  },

  tailwindcss: {
    cssPath: "~/assets/css/tailwind.css",
    configPath: "tailwind.config.ts",
  },

  typescript: {
    strict: true,
    typeCheck: false, // typechecked via the `typecheck` script
  },

  vite: {
    define: {
      __APP_VERSION__: JSON.stringify("0.2.0"),
    },
  },
});
