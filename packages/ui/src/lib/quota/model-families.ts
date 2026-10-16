/**
 * Models a provider's usage list selects by default, when the user has made no
 * selection yet.
 *
 * Anthropic only reports a model when that model has its own plan limit, so
 * every one it names is worth showing. The other providers report no models.
 */
export function getDefaultModels(providerId: string, availableModels: string[]): string[] {
  return providerId === 'claude' ? availableModels : [];
}
