/**
 * Platform window chrome contract shared by the main process and the renderer layout.
 * The renderer always starts below the 44px chrome band; only Windows reserves space
 * for the overlay buttons on the right.
 */

export const WINDOW_CHROME_HEIGHT = 44
export const WINDOWS_CONTROLS_INSET = 144

export const WINDOW_THEME_COLORS = {
  light: { color: '#f8f1ef', symbolColor: '#514d55', background: '#f7f8fc' },
  dark: { color: '#261f27', symbolColor: '#c2c7d3', background: '#11131a' },
} as const

export interface WindowChromeConfig {
  titleBarStyle: 'hidden' | 'hiddenInset'
  trafficLightPosition?: { x: number; y: number }
  titleBarOverlay?: {
    color: string
    symbolColor: string
    height: number
  }
  contentTop: typeof WINDOW_CHROME_HEIGHT
  windowsRightInset: number
}

export function getWindowChromeConfig(platform: NodeJS.Platform): WindowChromeConfig {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 14 },
      contentTop: WINDOW_CHROME_HEIGHT,
      windowsRightInset: 0,
    }
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // Electron uses the RGB value to choose hover contrast, even when alpha is zero.
      color: platform === 'win32' ? `${WINDOW_THEME_COLORS.light.color}00` : WINDOW_THEME_COLORS.light.color,
      symbolColor: WINDOW_THEME_COLORS.light.symbolColor,
      height: WINDOW_CHROME_HEIGHT,
    },
    contentTop: WINDOW_CHROME_HEIGHT,
    windowsRightInset: platform === 'win32' ? WINDOWS_CONTROLS_INSET : 0,
  }
}
