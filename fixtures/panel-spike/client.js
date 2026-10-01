/**
 * M0 spike — client half.
 *
 * This is the exact registration shape the Kanban board needs (PRD §11.3), and it
 * is copied from the one shipped plugin that does it —
 * `@deepseek-ai/dsh-client-ui-schedule`, which registers:
 *
 *     ctx.slots.inject('main', () => ctx.slots.register(
 *       { name: 'main', key: PANEL_ID, locale: MANAGER_NS, ... }, TaskManagerPage))
 *     ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
 *       { name: 'sidebar.panellist', id: PANEL_ID, order: 10, locale: MANAGER_NS,
 *         label: () => t('panel') }, TaskManagerIcon))
 *
 * Note the contract the pattern encodes: **the panellist row's `id` and the
 * `main` registration's `key` are the same string.** That is how selecting the
 * row addresses the panel.
 *
 * React comes from the browser module table via `require('react')` — never a
 * bundled or CDN copy.
 */

window.__ModuleLoader__.load({
  id: '@local/panel-spike',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Stands in for the board. */
    function SpikePanel() {
      return h(
        'div',
        {
          // `--dsh-frame-top-clearance` is the binding rule for a non-conversation
          // main panel: without it the content lands under the window chrome.
          style: { padding: 'var(--dsh-frame-top-clearance, 48px) 24px 24px', fontFamily: 'inherit' },
          'data-testid': 'panel-spike-panel',
        },
        h('h1', { style: { fontSize: '1.25rem', fontWeight: 600 } }, 'panel-spike'),
        h('p', { style: { marginTop: '8px' } }, 'The main keyed slot renders a third-party panel.'),
      )
    }

    /** Stands in for the sidebar nav icon row. */
    function SpikeIcon(props) {
      const size = (props && props.size) || 16
      return h(
        'span',
        {
          'aria-hidden': 'true',
          style: { fontSize: size + 'px', lineHeight: 1, display: 'block', textAlign: 'center' },
        },
        '◧',
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = []
          disposers.push(
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: 'spike' }, SpikePanel),
            ),
          )
          disposers.push(
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: 'spike', order: 3, label: 'Spike' },
                SpikeIcon,
              ),
            ),
          )
          globalThis.__DSH_PANEL_SPIKE_CLIENT__ = true
          return () => {
            for (const dispose of disposers) dispose()
            delete globalThis.__DSH_PANEL_SPIKE_CLIENT__
          }
        }, 'panel-spike: registrations')
      },
    }
  },
})
