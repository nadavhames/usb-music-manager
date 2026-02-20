import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "usb-music-manager",
		identifier: "usbmusicmanager.electrobun.dev",
		version: "0.0.2",
	},
	build: {
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	release: {
		baseUrl: 'https://github.com/nadavhames/usb-music-manager/releases/latest/download',
	},
} satisfies ElectrobunConfig;
