import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'circsim',
  description:
    'Load your routed PCB, power it up, and probe it in 3D — an interactive SPICE validation bench for boards you built before you pay for fabrication.',
  lang: 'en-US',

  // Deployed at https://epim.github.io/circsim/
  base: '/circsim/',

  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['meta', { name: 'theme-color', content: '#2f81f7' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'circsim — the validation bench for routed boards' }],
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Get started', link: '/start/install' },
      { text: 'Guides', link: '/guides/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Concepts', link: '/concepts/validation-bench' },
      {
        text: 'v0.2.8',
        items: [
          { text: 'Releases', link: 'https://github.com/epim/circsim/releases' },
          { text: 'What can it tell me?', link: '/concepts/fidelity' },
        ],
      },
    ],

    sidebar: {
      '/start/': [
        {
          text: 'Get started',
          items: [
            { text: 'Install circsim', link: '/start/install' },
            { text: 'Your first five minutes', link: '/start/first-run' },
            { text: 'Tutorial: First Light', link: '/start/first-light' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'The validation bench', link: '/concepts/validation-bench' },
            { text: 'From routed board to circuit', link: '/concepts/board-to-circuit' },
            { text: 'Models & resolution', link: '/concepts/models' },
            { text: 'Fidelity: what it can & can’t tell you', link: '/concepts/fidelity' },
            { text: 'The Board Critic', link: '/concepts/board-critic' },
          ],
        },
      ],
      '/guides/': [
        {
          text: 'How-to guides',
          items: [
            { text: 'Overview', link: '/guides/' },
            { text: 'Open a routed board', link: '/guides/open-board' },
            { text: 'Attach a schematic', link: '/guides/attach-schematic' },
            { text: 'Set ground & supply', link: '/guides/ground-and-supply' },
            { text: 'Energize & read the operating point', link: '/guides/energize' },
            { text: 'Use the bench & draw leads', link: '/guides/bench-and-leads' },
            { text: 'Probe nets & read the scope', link: '/guides/probe-and-scope' },
            { text: 'Fix an unresolved part', link: '/guides/model-doctor' },
            { text: 'Run the Board Critic audit', link: '/guides/run-critic' },
            { text: 'Read the warnings & fidelity banner', link: '/guides/warnings' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'Model library', link: '/reference/model-library' },
            { text: 'Bench instruments', link: '/reference/instruments' },
            { text: 'Board Critic checks', link: '/reference/critic-checks' },
            { text: 'Pin-map precedence', link: '/reference/pin-maps' },
            { text: 'Supported files', link: '/reference/file-formats' },
            { text: 'Architecture', link: '/reference/architecture' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/epim/circsim' }],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/epim/circsim/edit/master/website/docs/:path',
      text: 'Suggest an edit to this page',
    },

    footer: {
      message: 'Released under the MIT License. circsim is fully offline and never modifies your design files.',
      copyright: 'circsim — the validation bench for routed boards',
    },
  },
})
