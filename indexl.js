
// TODO
// [OK] youku support
// [OK] tudou support
// [OK] video player shortcut
// [OK] double buffered problem: http://www.bilibili.com/video/av4376362/index_3.html at 360.0s
//      discontinous audio problem: http://www.bilibili.com/video/av3067286/ at 97.806,108.19
//      discontinous audio problem: http://www.bilibili.com/video/av1965365/index_6.html at 51.806
// [OK] fast start
// [OK] open twice
// [OK] http://www.bilibili.com/video/av3659561/index_57.html: Error: empty range, maybe video end
// [OK] http://www.bilibili.com/video/av3659561/index_56.html: First segment too small
// [OK] double buffered problem: http://www.bilibili.com/video/av4467810/
// [OK] double buffered problem: http://www.bilibili.com/video/av3791945/ 
// 	   [[2122.957988,2162.946522],[2163.041988,2173.216033]]
// [OK] video reset problem: http://www.bilibili.com/video/av314/
// [OK] video stuck problem: http://www.tudou.com/albumplay/-3O0GyT_JkQ/Az5cnjgva4k.html 16:11
// [OK] InitSegment invalid: http://www.bilibili.com/video/av1753789 
// EOF error at index 67 http://www.bilibili.com/video/av4593775/
// EOF error at index 166,168 http://www.tudou.com/albumplay/92J2xqpSxWY/m4dBe7EG-7Q.html

// Test needed for safari: 
//    xhr cross origin, change referer header, pass arraybuffer efficiency,
//    mse playing

'use strict'

//let localhost = 'http://localhost:6060/'

let mediaSource = require('./mediaSource');
let Nanobar = require('./nanobar');
let bilibili = require('./bilibili');
//let youku = require('./youku');
//let tudou = require('./tudou');
let createPlayer = require('./player');
let flashBlocker = require('./flashBlocker');
let flvdemux = require('./flvdemux');
let FastDamoo = require('./damoo');

let nanobar = new Nanobar();

let style = document.createElement('style');
let themeColor = '#DF6558';

style.innerHTML = `
.nanobar .bar {
	background: ${themeColor};
}
.nanobar {
	z-index: 1000001;
	left: 0px;
	top: 0px;
}
.mama-toolbar {
	position: absolute;
	z-index: 1;
	bottom: 20px;
	right: 20px;
}

.mama-toolbar svg {
	width: 17px;
	color: #fff;
	fill: currentColor;
	cursor: pointer;
}

.mama-toolbar {
	display: flex;
	padding: 5px;
	padding-left: 15px;
	padding-right: 15px;
	border-radius: 5px;
	align-items: center;
	background: #333;
}

.mama-toolbar input[type=range]:focus {
  outline: none;
}

.mama-toolbar .selected {
	color: ${themeColor};
}

.mama-toolbar input[type=range] {
	-webkit-appearance: none;
  height: 9px;
	width: 75px;
	border-radius: 3px;
	margin: 0;
	margin-right: 8px;
}

.mama-toolbar input[type=range]::-webkit-slider-thumb {
	-webkit-appearance: none;
	height: 13px;
	width: 5px;
	background: ${themeColor};
	border-radius: 1px;
}
`

document.head.appendChild(style);
mediaSource.debug = true;

let getSeeker = url => {
	let seekers = [bilibili];
	let found = seekers.filter(s => s.testUrl(url));
	return found[0];
}

let playVideo = res => {
	let player = createPlayer();
	let media = mediaSource.bindVideo({
		video:player.video,
		src:res.src,
		duration:res.duration,
	});
	player.streams = media.streams;
	return {player, media};
}

let handleDamoo = (vres, player, seeker, media) => {
	let mode;
	if (seeker.getAllDamoo) {
		mode = 'all';
	} else if (seeker.getDamooProgressive) {
		mode = 'progressive';
	}

	if (!mode)
		return;

	let damoos = [];

	(() => {
		if (mode == 'all') {
			return seeker.getAllDamoo(vres).then(res => {
				damoos = res;
			});
		} else if (mode == 'progressive') {
			return new Promise((fulfill, reject) => {
				seeker.getDamooProgressive(vres, res => {
					damoos = damoos.concat(res);
					//console.log(`damoo: loaded n=${damoos.length}`);
					fulfill();
				})
			});
		}
	})().then(() => {
		let video = player.video;
		let updating;
		let cur = 0;
		let emitter;

		let update = () => {
			let time = video.currentTime+1.0;
			if (cur < damoos.length && time > damoos[cur].time) {
				for (; cur < damoos.length && damoos[cur].time <= time; cur++) {
					let d = damoos[cur];
					//console.log('damoo: emit', `${Math.floor(d.time/60)}:${Math.floor(d.time%60)}`, d.text);
					emitter.emit({text: d.text, pos: d.pos, shadow: {color: '#000'}, color: d.color});
				}
			}
			updating = setTimeout(update, 1000);
		};
		let stopUpdate = () => {
			if (updating) {
				clearTimeout(updating);
				updating = null;
			}
		}
		let startUpdate = () => {
			if (!updating)
				update();
		}

		let resetCur = () => {
			let time;
			for (cur = 0; cur < damoos.length; cur++) {
				if (damoos[cur].time > video.currentTime) {
					time = damoos[cur].time;
					break;
				}
			}
			console.log(`damoo: cur=${cur}/${damoos.length} time=${time}`);
		}

		media.onSeek.push(() => {
			emitter.clear();
			resetCur();
		})

		player.onResume.push(() => {
			if (emitter == null) {
	 			emitter = new FastDamoo({container:player.damoo, fontSize:20});
				let setDamooOpts = () => {
					player.damoo.style.opacity = player.damooOpacity;
					if (player.damooEnabled) {
						emitter.show();
					} else {
						emitter.hide();
					}
				}
				player.onDamooOptsChange.push(() => setDamooOpts());
				setDamooOpts();
			}
			emitter.synctime(video.currentTime);
			emitter.resume()
			startUpdate();
		});
		player.onSuspend.push(() => {
			emitter.synctime(video.currentTime);
			emitter.suspend()
			stopUpdate();
		});

	});
}
exports.playVideo=playVideo;
let playUrl = url => {
	return new Promise((fulfill, reject) => {
		let seeker = getSeeker(url)
		if (seeker) {
			flashBlocker();
			nanobar.go(30);
			seeker.getVideos(url).then(res => {
				console.log('getVideosResult:', res);
				if (res) {
					let ctrl = playVideo(res);
					ctrl.player.onStarted.push(() => nanobar.go(100));
					handleDamoo(res, ctrl.player, seeker, ctrl.media);
					nanobar.go(60)
					fulfill(ctrl);
				} else {
					throw new Error('getVideosResult: invalid')
				}
			}).catch(e => {
				nanobar.go(100);
				throw e;
			});
		} else {
			throw new Error('seeker not found');
		}
	});
}

exports.playUrl=playUrl;
