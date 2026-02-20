import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "usb-music-manager",
		identifier: "usbmusicmanager.electrobun.dev",
		version: "0.0.1",
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
		// Set this to your artifacts host (S3, R2, GitHub Releases, etc.) to
		// enable auto-updates. Upload the contents of the `artifacts/` folder
		// here after each build. Leave empty to disable update checks.
		//
		// baseUrl: 'https://your-releases-bucket.example.com/usb-music-manager/',
		baseUrl: '',
	},
} satisfies ElectrobunConfig;
