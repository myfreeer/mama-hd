
//TODO
// [DONE] sourceBuffer: opeartion queue
// [DONE] seek to keyframe problem
// [DONE] rewrite fetchMediaSegment
// seeking start seeking end cb, when seeking not end bufupdate not seek
// [DONE] xhr retry

'use strict'

let flvdemux = require('./flvdemux')
let mp4mux = require('./mp4mux')
let fetch = require('./http').fetch;
const cacheTimeLength = 360;
let xhrTimeout = 1500;
const firstxhrTimeout = xhrTimeout;

let app = {}

let dbp = console.log.bind(console);

let concatUint8Array = function(list) {
	let len = 0;
	list.forEach(b => len += b.byteLength)
	let res = new Uint8Array(len);
	let off = 0;
	list.forEach(b => {
		res.set(b, off);
		off += b.byteLength;
	})
	return res;
}

class Streams {
	constructor({urls,fakeDuration}) {
		if (fakeDuration == null)
			throw new Error('fakeDuration must set');
		this.urls = urls;
		this.fakeDuration = fakeDuration;
		this.streams = [];
		this.duration = 0;
		this.keyframes = [];
		this.probeIdx = 0;
	}

	probeFirst() {
		return this.probeOneByOne();
	}

	fetchInitSegment(url) {
		let parser = new flvdemux.InitSegmentParser();
		let pump = reader => {
			return reader.read().then(res => {
				if (res.done) {
					//dbp('initsegparser: EOF');
					return;
				}
				let chunk = res.value;
				//dbp(`initsegparser: incoming ${chunk.byteLength}`);
				let done = parser.push(chunk);
				if (done) {
					//dbp('initsegparser: finished', done);
					reader.cancel();
					return done;
				} else {
					return pump(reader);
				}
			});
		}
		return fetch(url, {headers: {Range: 'bytes=0-5000000'}, retries: 128}).then(res => {
			return pump(res.body.getReader())
		});
	}

	probeOneByOne() {
		let url = this.urls[this.probeIdx];
		return this.fetchInitSegment(url).then(flvhdr => {
			if (flvhdr == null)
				return Promise.reject(new Error('probe '+url+' failed'));
			let stream = flvhdr;

			this.streams.push(stream);
			stream.duration = stream.meta.duration;
			stream.timeStart = this.duration;
			stream.timeEnd = this.duration+stream.duration;
			stream.indexStart = this.keyframes.length;

			let keyframes = stream.meta.keyframes;
			keyframes.times.forEach((time, i) => {
				let last = i==keyframes.times.length-1;
				let entry = {
					timeStart: stream.timeStart+time,
					timeEnd: stream.timeStart+(last?stream.duration:keyframes.times[i+1]),
					urlIdx: this.probeIdx,
					rangeStart: keyframes.filepositions[i],
					rangeEnd: last?stream.meta.filesize:keyframes.filepositions[i+1],
				};
				entry.duration = entry.timeEnd-entry.timeStart;
				entry.size = entry.rangeEnd-entry.rangeStart;
				this.keyframes.push(entry);
			});
			this.duration += stream.duration;

			if (this.probeIdx == 0) {
				if (flvhdr.firstv.AVCDecoderConfigurationRecord == null)
					throw new Error('AVCDecoderConfigurationRecord not found');
				if (flvhdr.firsta.AudioSpecificConfig == null)
					throw new Error('AudioSpecificConfig not found');

				let record = flvhdr.firstv.AVCDecoderConfigurationRecord;
				dbp('probe:', `h264.profile=${record[1].toString(16)}`, 'meta', flvhdr);

				this.videoTrack = {
					type: 'video',
					id: 1,
					duration: Math.ceil(this.fakeDuration*mp4mux.timeScale),
					width: flvhdr.meta.width,
					height: flvhdr.meta.height,
					AVCDecoderConfigurationRecord: flvhdr.firstv.AVCDecoderConfigurationRecord,
				};
				this.audioTrack = {
					type: 'audio',
					id: 2,
					duration: this.videoTrack.duration,
					channelcount: flvhdr.firsta.channelCount,
					samplerate: flvhdr.firsta.sampleRate,
					samplesize: flvhdr.firsta.sampleSize,
					AudioSpecificConfig: flvhdr.firsta.AudioSpecificConfig,
				};
			}

			this.probeIdx++;
			dbp(`probe: got ${this.probeIdx}/${this.urls.length}`);

			if (this.onProbeProgress)
				this.onProbeProgress(stream, this.probeIdx-1);
			if (this.probeIdx < this.urls.length) {
				this.probeOneByOne();
			}
		});
	}

	findIndexByTime(time, opts) {
		if (time < 0 || time > this.duration)
			return;
		let minDiff = this.duration, best;
		this.keyframes.forEach((keyframe, i) => {
			let diff = time-keyframe.timeStart;
			let absDiff = Math.abs(diff);
			if (absDiff < minDiff) {
				minDiff = absDiff;
				best = i;
			}
		});
		return best;

		let choose = 0;
		for (let i = 0; i < this.keyframes.length; i++) {
			let e = this.keyframes[i];
			if (time <= e.timeEnd) {
				choose = i; 
				break;
			}
		}
		return choose;
	}

	fetchMediaSegmentsByIndex(indexStart, indexEnd) {
		let ranges = [];
		let totalSize = 0;

		for (let i = indexStart; i <= indexEnd; i++) {
			let e = this.keyframes[i];
			let url = this.urls[e.urlIdx];
			let range;
			if (ranges.length == 0 || ranges[ranges.length-1].url != url) {
				range = {url, start:e.rangeStart, end:e.rangeEnd};
				range.streamTimeBase = this.streams[e.urlIdx].timeStart;
				range.timeStart = e.timeStart;
				range.indexStart = i;
				ranges.push(range);
			} else {
				range = ranges[ranges.length-1];
			}
			range.indexEnd = i;
			range.end = e.rangeEnd;
			range.timeEnd = e.timeEnd;
			range.duration = range.timeEnd-range.timeStart;
			totalSize += e.size;
		}

		if (ranges.length == 0)
			throw new Error('ranges.length = 0');

		let timeStart = this.keyframes[indexStart].timeStart;
		let timeEnd = this.keyframes[indexEnd].timeEnd;
		dbp('fetch:', `index=[${indexStart},${indexEnd}] `+
									`time=[${timeStart},${timeEnd}] size=${totalSize/1e6}M range.nr=${ranges.length}`);

		let resbuf = [];
		let fulfill;
		let xhr;

		let promise = new Promise((_fulfill, reject) => {
			fulfill = _fulfill;

			let request = i => {
				let range = ranges[i];
				let {url,start,end} = range;
				dbp('fetch:', `bytes=[${start},${end}]`);
				if (start == end) throw new Error('EOF');
				xhr = new XMLHttpRequest();
				xhr.open('GET', url);
				xhr.responseType = 'arraybuffer';
				{
					let range;
					if (start || end) {
						range = 'bytes=';
						if (start)
							range += start;
						else
							range += '0';
						range += '-'
						if (end)
							range += end-1;
					}
					if (range !== undefined) {
						xhr.setRequestHeader('Range', range);
					}
				}
				xhr.onerror = () => {
					xhr.abort();
					xhrTimeout = firstxhrTimeout + 3500;
					xhr.timeout = xhrTimeout;
					setTimeout(() => request(i), 150);
				}
				xhr.ontimeout = xhr.onerror;
				xhr.timeout = xhrTimeout;
				
				xhr.onreadystatechange = () => {
					//32768 = 256 / 8 * 1024 ,simulating a 256kbps network (hardly to find a network slower than this)
					if (xhr.readyState == 3) xhr.timeout = xhrTimeout + (end - start) / 32768 + 1000;
					if (xhr.getResponseHeader('Content-Length') > end - start + 1000) xhr.onerror();
				}

				xhr.onload = () => {
					xhrTimeout = firstxhrTimeout
					if (xhr.response.byteLength < end - start && i+1 <= ranges.length) xhr.onerror();
					let segbuf = new Uint8Array(xhr.response);
					let cputimeStart = new Date().getTime();
					let buf = this.transcodeMediaSegments(segbuf, range);
					let cputimeEnd = new Date().getTime();
					dbp('transcode:', `[${range.indexStart},${range.indexEnd}]`, 'cputime(ms):', (cputimeEnd-cputimeStart), 
							'segbuf(MB)', segbuf.byteLength/1e6,
							'videotime(s)', range.duration
						 );
					resbuf.push(buf);
					if (i+1 < ranges.length) {
						request(i+1);
					} else {
						fulfill(concatUint8Array(resbuf));
					}
				}

				xhr.send();
			}

			request(0);
		});

		promise.cancel = () => {
			xhr.abort();
			fulfill();
		};

		promise.timeStart = timeStart;
		promise.timeEnd = timeEnd;

		return promise;
	}

	getInitSegment() {
		return mp4mux.initSegment([this.videoTrack, this.audioTrack], this.fakeDuration*mp4mux.timeScale);
	}

	transcodeMediaSegments(segbuf, range) {
		let segpkts = flvdemux.parseMediaSegment(segbuf);

		let lastSample, lastDuration, duration;
		let videoTrack = this.videoTrack;
		let audioTrack = this.audioTrack;

		// baseMediaDecodeTime=firstpacket.time [video][video][video][video] nextkeyframe.time
		// baseMediaDecodeTime=firstpacket.time [audio][audio][audio][audio] keyframe.time+aac_total_duration

		if (this._lastTranscodeRangeEndIndex !== undefined && 
				this._lastTranscodeRangeEndIndex+1 === range.indexStart) {
			audioTrack._firstTime = audioTrack._lastTime;
			videoTrack._firstTime = videoTrack._lastTime;
		} else {
			delete audioTrack._firstTime;
			delete videoTrack._firstTime;
		}
		this._lastTranscodeRangeEndIndex = range.indexEnd;

		videoTrack._mdatSize = 0;
		videoTrack.samples = [];
		audioTrack._mdatSize = 0;
		audioTrack.samples = [];

		lastSample = null;
		duration = 0;
		segpkts.filter(pkt => pkt.type == 'video' && pkt.NALUs).forEach((pkt, i) => {
			let sample = {};
			sample._data = pkt.NALUs;
			sample._offset = videoTrack._mdatSize;
			sample.size = sample._data.byteLength;
			videoTrack._mdatSize += sample.size;

			if (videoTrack._firstTime === undefined) {
				videoTrack._firstTime = pkt.dts+range.streamTimeBase;
			}
			sample._dts = pkt.dts;
			sample.compositionTimeOffset = pkt.cts*mp4mux.timeScale;

			sample.flags = {
				isLeading: 0,
				dependsOn: 0,
				isDependedOn: 0,
				hasRedundancy: 0,
				paddingValue: 0,
				isNonSyncSample: pkt.isKeyFrame?0:1,
				degradationPriority: 0,
			};

			if (lastSample) {
				let diff = sample._dts-lastSample._dts;
				lastSample.duration = diff*mp4mux.timeScale;
				duration += diff;
			}
			lastSample = sample;
			videoTrack.samples.push(sample);
		});
		lastSample.duration = (range.duration-duration)*mp4mux.timeScale;
		videoTrack._lastTime = range.timeEnd;

		lastSample = null;
		duration = 0;
		segpkts.filter(pkt => pkt.type == 'audio' && pkt.frame).forEach((pkt, i) => {
			let sample = {};
			sample._data = pkt.frame;
			sample._offset = audioTrack._mdatSize;
			sample.size = sample._data.byteLength;
			audioTrack._mdatSize += sample.size;

			//dbp('audiosample', pkt.dts, pkt.frame.byteLength);

			if (audioTrack._firstTime === undefined) {
				audioTrack._firstTime = pkt.dts+range.streamTimeBase;
			}
			sample._dts = pkt.dts;

			if (lastSample) {
				let diff = sample._dts-lastSample._dts;
				lastSample.duration = diff*mp4mux.timeScale;
				duration += diff;
				lastDuration = diff;
			}
			lastSample = sample;
			audioTrack.samples.push(sample);
		});
		lastSample.duration = lastDuration*mp4mux.timeScale;
		audioTrack._lastTime = duration+lastDuration+audioTrack._firstTime;

		videoTrack.baseMediaDecodeTime = videoTrack._firstTime*mp4mux.timeScale;
		audioTrack.baseMediaDecodeTime = audioTrack._firstTime*mp4mux.timeScale;

		if (0) {
			let totdur = x => x.samples.reduce((val,e) => val+e.duration, 0);
			dbp('av.samplesCount',audioTrack.samples.length, videoTrack.samples.length);
			dbp('av.duration:', totdur(audioTrack)/mp4mux.timeScale,totdur(videoTrack)/mp4mux.timeScale);
			dbp('av.firstTime:', audioTrack._firstTime, videoTrack._firstTime);
			dbp('av.lastTime:', audioTrack._lastTime, videoTrack._lastTime);
		}

		let moof, _mdat, mdat;
		let list = [];

		moof = mp4mux.moof(0, [videoTrack]);
		_mdat = new Uint8Array(videoTrack._mdatSize);
		videoTrack.samples.forEach(sample => _mdat.set(sample._data, sample._offset));
		mdat = mp4mux.mdat(_mdat);
		list = list.concat([moof, mdat]);

		moof = mp4mux.moof(0, [audioTrack]);
		_mdat = new Uint8Array(audioTrack._mdatSize);
		audioTrack.samples.forEach(sample => _mdat.set(sample._data, sample._offset));
		mdat = mp4mux.mdat(_mdat);
		list = list.concat([moof, mdat]);

		return concatUint8Array(list);
	}
}

function debounce(start, interval) {
	var timer;
	return function() {
		var context = this, args = arguments;
		var later = function() {
			timer = null;
			start.apply(context, args);
		};
		if (timer) {
			clearTimeout(timer);
		} else {
			start.apply(context, args);
		}
		timer = setTimeout(later, interval);
	};
};

function triggerPerNr(fn, nr) {
	let counter = 0;
	return () => {
		counter++;
		if (counter == nr) {
			counter = 0;
			fn();
		}
	}
}

app.bindVideo = (opts) => {
	let video = opts.video;
	let streams = new Streams({urls:opts.src, fakeDuration:opts.duration});
	let mediaSource = new MediaSource();
	video.src = URL.createObjectURL(mediaSource);

	let self = {mediaSource, streams, onSeek: []};

	let sourceBuffer;
	let sourceBufferOnUpdateend;

	let tryPrefetch;
	let clearBufferAndPrefetch;
	{
		let fetching;
		let pending = [];

		let doaction = fn => {
			if (sourceBuffer.updating) {
				pending.push(fn);
			} else fn()
		}

		sourceBufferOnUpdateend = () => {
			if (pending.length > 0) {
				dbp('updateend: do pending');
				pending[0]();
				pending = pending.slice(1);
			}
			let buffered = sourceBuffer.buffered;
		}

		let fetchAndAppend = (time,duration) => {
			let indexStart = streams.findIndexByTime(time);
			if (indexStart == null)
				return;
			let indexEnd = indexStart;
			for (let i = indexStart; i < streams.keyframes.length; i++) {
				let e = streams.keyframes[i];
				if (e.timeEnd > time+duration) {
					indexEnd = i;
					break;
				}
			}

			let sess = streams.fetchMediaSegmentsByIndex(indexStart, indexEnd);
			fetching = sess;
			sess.then(segbuf => {
				if (sess === fetching) {
					fetching = null;
				}
				if (segbuf) {
					doaction(() => sourceBuffer.appendBuffer(segbuf));
				}
			});
		}

		let stopFetching = () => {
			if (fetching) {
				fetching.cancel();
				fetching = null;
			}
		}

		tryPrefetch = (duration=10) => {
			if (fetching || sourceBuffer.updating)
				return;

			let time;
			let buffered = sourceBuffer.buffered;
			if (buffered.length > 0) {
				time = buffered.end(buffered.length-1);
			} else {
				time = 0;
			}

			if (time < video.currentTime + cacheTimeLength +1 && time < video.duration)
				fetchAndAppend(time, duration);
		}

		clearBufferAndPrefetch = (duration=10) => {
			dbp('prefetch: clearBufferAndPrefetch');

			if (sourceBuffer.updating)
				sourceBuffer.abort();

			let time = video.currentTime;
			stopFetching();

			sourceBuffer.remove(0, video.duration);
			if (time > streams.duration) {
				// wait probe done
			} else {
				fetchAndAppend(time, duration);
			}
		}
	}

	let currentTimeIsBuffered = () => {
		let buffered = sourceBuffer.buffered;
		if (buffered.length == 0)
			return;
		return video.currentTime >= buffered.start(0) && 
				video.currentTime < buffered.end(buffered.length-1);
	};

	streams.onProbeProgress = (stream, i) => {
		if (i > 0 && stream.timeStart <= video.currentTime && video.currentTime < stream.timeEnd) {
			dbp('onProbeProgress:', i, 'need prefetch');
			clearBufferAndPrefetch();
		}
	}

	video.addEventListener('seeking', debounce(() => {
		if (!currentTimeIsBuffered()) {
			dbp('seeking(not buffered):', video.currentTime);
			clearBufferAndPrefetch();
		} else {
			dbp('seeking(buffered):', video.currentTime);
		}
		self.onSeek.forEach(x => x());
	}, 200));

	mediaSource.addEventListener('sourceended', () => dbp('mediaSource: sourceended'))
	mediaSource.addEventListener('sourceclose', () => dbp('mediaSource: sourceclose'))

	mediaSource.addEventListener('sourceopen', e => {
		if (mediaSource.sourceBuffers.length > 0)
			return;

		//sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.64001E, mp4a.40.2"');
		let codecType = 'video/mp4; codecs="avc1.640029, mp4a.40.05"';
		dbp('codec supported:', MediaSource.isTypeSupported(codecType));
		sourceBuffer = mediaSource.addSourceBuffer(codecType);
		self.sourceBuffer = sourceBuffer;

		sourceBuffer.addEventListener('error', (e) => {dbp('sourceBuffer: error', e);clearInterval(interval)});
		sourceBuffer.addEventListener('abort', () => dbp('sourceBuffer: abort'));
		let interval;
		sourceBuffer.addEventListener('updateend', () => {
			//dbp('sourceBuffer: updateend')
			sourceBufferOnUpdateend();
		});

		sourceBuffer.addEventListener('update', () => {
			let ranges = [];
			let buffered = sourceBuffer.buffered;
			for (let i = 0; i < buffered.length; i++) {
				ranges.push([buffered.start(i), buffered.end(i)]);
			}
			dbp('bufupdate:', JSON.stringify(ranges), 'time', video.currentTime);

			if (buffered.length > 0) {
				if (video.currentTime < buffered.start(0) || 
						video.currentTime > buffered.end(buffered.length-1)) 
				{
					video.currentTime = buffered.start(0)+0.1;
				}
			}
		});

		streams.probeFirst().then(() => {
			sourceBuffer.appendBuffer(streams.getInitSegment());
		});

		video.addEventListener('loadedmetadata', () => {
			tryPrefetch(5.0);
			interval = setInterval(() => {
				tryPrefetch();
			}, 1500);
		});
	});

	return self;
}

app.Streams = Streams;
module.exports = app;

