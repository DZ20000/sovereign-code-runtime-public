const INHERITED_SECRET_NAME =
  /^(?:SCR_(?:.*_)?(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH_HEADER|RUNTIME_KEY)|CONTROL_PLANE_API_KEY)$/iu;

export function sanitizedChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !INHERITED_SECRET_NAME.test(name)) {
      result[name] = value;
    }
  }
  return result;
}
