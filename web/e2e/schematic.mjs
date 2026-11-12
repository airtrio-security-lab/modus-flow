/**
 * The scenarios written for the schematic city keep checking the schematic city: where the device can
 * run WebGL the product now opens «3D-город» by default (ADR-0022), which has its own scenario
 * (world3d-flow.mjs). A person's stored choice is respected, so a scenario that switches the view
 * itself is not overridden.
 */
export function schematic(browser) {
  const make = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const ctx = await make(options);
    await ctx.addInitScript(() => {
      try {
        if (!localStorage.getItem('modus.kingdom.mode')) localStorage.setItem('modus.kingdom.mode', 'city');
      } catch {
        /* storage unavailable */
      }
    });
    return ctx;
  };
  return browser;
}
