import process from 'node:process'

export const previewBrowserOptions = () => process.env.SEP_PREVIEW_BROWSER ? { executablePath: process.env.SEP_PREVIEW_BROWSER } : { channel: 'msedge' }

export async function selectComposerModel(page, modelId) {
  await page.getByRole('combobox', { name: '模型', exact: true }).click()
  await page.getByRole('dialog', { name: '选择模型', exact: true }).getByRole('option', { name: modelId || '暂不选择', exact: true }).click()
}

export async function composerModelOptions(page) {
  await page.getByRole('combobox', { name: '模型', exact: true }).click()
  const options = await page.getByRole('dialog', { name: '选择模型', exact: true }).getByRole('option').allTextContents()
  await page.keyboard.press('Escape')
  return options
}
