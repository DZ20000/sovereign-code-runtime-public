import { describe, expect, it } from "vitest";
import { defaultUiSettings, normalizeUiSettings } from "../src/renderer/interface-preferences.js";
describe("interface preference migration", () => {
  const defaults = defaultUiSettings("en");
  it("migrates old routes into the consolidated navigation", () => {
    expect(normalizeUiSettings({startupView:"agent"}, defaults).startupView).toBe("overview");
    expect(normalizeUiSettings({startupView:"runs"}, defaults).startupView).toBe("tasks");
  });
  it("starts at 100 percent and follows the system theme", () => {
    expect(defaults.uiScale).toBe(1);
    expect(defaults.theme).toBe("system");
    expect(defaultUiSettings("zh-Hans").language).toBe("zh-CN");
  });
  it("bounds malformed stored settings without dropping valid accessibility preferences", () => {
    const result = normalizeUiSettings({theme:"dark",fontScale:1.3,uiScale:1.5,reducedMotion:true,refreshIntervalMs:-1}, defaults);
    expect(result).toMatchObject({theme:"dark",fontScale:1.3,uiScale:1.5,reducedMotion:true,refreshIntervalMs:5000});
    expect(normalizeUiSettings(null, defaults)).toEqual(defaults);
    expect(normalizeUiSettings({theme:"unexpected",fontScale:1000},defaults)).toMatchObject({theme:"system",fontScale:1});
  });
});
