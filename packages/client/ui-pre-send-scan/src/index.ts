/**
 * Host plugin body — no host-side behavior for the pre-send scan plugin.
 * The browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration; the empty apply exists so the plugin
 * appears in the host cordis.yml / Loader.
 */

export function apply(): void {}
