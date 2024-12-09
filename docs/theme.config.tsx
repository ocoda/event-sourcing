
import { useConfig, type DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: <>
    <img src="https://github.com/ocoda/.github/raw/master/assets/ocoda_logo_only_gradient.svg" width="40" alt="Ocoda Logo" />
    <span style={{ marginLeft: '.4em', fontWeight: 700 }}>
        Ocoda | Event Sourcing
      </span>
  </>,
  project: {
    link: 'https://github.com/ocoda/event-sourcing',
  },
  docsRepositoryBase: 'https://github.com/ocoda/event-sourcing/tree/master/docs',
  footer: {
    content: (
        <span>
          MIT {new Date().getFullYear()} ©{' '}
          <a href="https://nextra.site" target="_blank" rel="noreferrer">
            Ocoda
          </a>
          .
        </span>
      )
  },
  head: function useHead() {
    const config = useConfig()
    const title = `${config.title} – Ocoda Event Sourcing`
    return (
      <>
        <title>{title}</title>
      </>
    )
  },
}

export default config