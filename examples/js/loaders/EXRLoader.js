/**
 * @author Richard M. / https://github.com/richardmonette
 *
 * OpenEXR loader which, currently, supports reading 16 bit half data, in either
 * uncompressed or PIZ wavelet compressed form.
 *
 * Referred to the original Industrial Light & Magic OpenEXR implementation and the TinyEXR / Syoyo Fujita
 * implementation, so I have preserved their copyright notices.
 */

// /*
// Copyright (c) 2014 - 2017, Syoyo Fujita
// All rights reserved.

// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//     * Neither the name of the Syoyo Fujita nor the
//       names of its contributors may be used to endorse or promote products
//       derived from this software without specific prior written permission.

// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
// */

// // TinyEXR contains some OpenEXR code, which is licensed under ------------

// ///////////////////////////////////////////////////////////////////////////
// //
// // Copyright (c) 2002, Industrial Light & Magic, a division of Lucas
// // Digital Ltd. LLC
// //
// // All rights reserved.
// //
// // Redistribution and use in source and binary forms, with or without
// // modification, are permitted provided that the following conditions are
// // met:
// // *       Redistributions of source code must retain the above copyright
// // notice, this list of conditions and the following disclaimer.
// // *       Redistributions in binary form must reproduce the above
// // copyright notice, this list of conditions and the following disclaimer
// // in the documentation and/or other materials provided with the
// // distribution.
// // *       Neither the name of Industrial Light & Magic nor the names of
// // its contributors may be used to endorse or promote products derived
// // from this software without specific prior written permission.
// //
// // THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// // "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// // LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// // A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// // OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// // SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// // LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// // DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// // THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// // (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// // OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
// //
// ///////////////////////////////////////////////////////////////////////////

// // End of OpenEXR license -------------------------------------------------

THREE.EXRLoader = function ( manager ) {

	this.manager = ( manager !== undefined ) ? manager : THREE.DefaultLoadingManager;

};

THREE.EXRLoader.prototype = Object.create( THREE.DataTextureLoader.prototype );

THREE.EXRLoader.prototype._parser = function ( buffer ) {

	const USHORT_RANGE = (1 << 16);
	const BITMAP_SIZE = (USHORT_RANGE >> 3);

	const HUF_ENCBITS = 16;  // literal (value) bit length
	const HUF_DECBITS = 14;  // decoding bit size (>= 8)

	const HUF_ENCSIZE = (1 << HUF_ENCBITS) + 1;  // encoding table size
	const HUF_DECSIZE = 1 << HUF_DECBITS;        // decoding table size
	const HUF_DECMASK = HUF_DECSIZE - 1;

	const SHORT_ZEROCODE_RUN = 59;
	const LONG_ZEROCODE_RUN = 63;
	const SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;
	const LONGEST_LONG_RUN = 255 + SHORTEST_LONG_RUN;

	const BYTES_PER_HALF = 2;

	function reverseLutFromBitmap(bitmap, lut) {
		var k = 0;

		for (var i = 0; i < USHORT_RANGE; ++i) {
			if ((i == 0) || (bitmap[i >> 3] & (1 << (i & 7)))) {
				lut[k++] = i;
			}
		}

		var n = k - 1;

		while (k < USHORT_RANGE) lut[k++] = 0;

		return n;
	}

	function hufClearDecTable(hdec) {
		for (var i = 0; i < HUF_DECSIZE; i++) {
			hdec[i] = {}
			hdec[i].len = 0;
			hdec[i].lit = 0;
			hdec[i].p = null;
		}
	}

	function getBits(nBits, c, lc, inBuffer, inOffset) {
		while (lc < nBits) {
			c = (c << 8) | parseUint8(inBuffer, inOffset);
			lc += 8;
		}

		lc -= nBits;

		return { l: (c >> lc) & ((1 << nBits) - 1), c: c, lc: lc };
	}

	function hufCanonicalCodeTable(hcode) {
		var n = new Array(59);

		for (var i = 0; i <= 58; ++i) n[i] = 0;

		for (var i = 0; i < HUF_ENCSIZE; ++i) n[hcode[i]] += 1;

		var c = 0;

		for (var i = 58; i > 0; --i) {
			var nc = ((c + n[i]) >> 1);
			n[i] = c;
			c = nc;
		}

		for (var i = 0; i < HUF_ENCSIZE; ++i) {
			var l = hcode[i];

			if (l > 0) hcode[i] = l | (n[l]++ << 6);
		}
	}

	function hufUnpackEncTable(inBuffer, inOffset, ni, im, iM, hcode) {
		var p = inOffset;
		var c = 0;
		var lc = 0;

		for (; im <= iM; im++) {
			if (p.value - inOffset.value > ni) {
				return false;
			}

			var bits = getBits(6, c, lc, inBuffer, p);
			var l = bits.l;
			c = bits.c;
			lc = bits.lc;
			hcode[im] = l;

			if (l == LONG_ZEROCODE_RUN) {
				if (p.value - inOffset.value > ni) {
					throw 'Something wrong with hufUnpackEncTable';
				}

				var bits = getBits(8, c, lc, inBuffer, p);
				var zerun = bits.l + SHORTEST_LONG_RUN;
				c = bits.c;
				lc = bits.lc;

				if (im + zerun > iM + 1) {
					throw 'Something wrong with hufUnpackEncTable';
				}

				while (zerun--) hcode[im++] = 0;

				im--;
			} else if (l >= SHORT_ZEROCODE_RUN) {
				var zerun = l - SHORT_ZEROCODE_RUN + 2;

				if (im + zerun > iM + 1) {
					throw 'Something wrong with hufUnpackEncTable';
				}

				while (zerun--) hcode[im++] = 0;

				im--;
			}
		}

		hufCanonicalCodeTable(hcode);
	}

	function hufLength(code) { return code & 63; }

	function hufCode(code) { return code >> 6; }

	function hufBuildDecTable(hcode, im, iM, hdecod) {
		for (; im <= iM; im++) {
			var c = hufCode(hcode[im]);
			var l = hufLength(hcode[im]);

			if (c >> l) {
				throw 'Invalid table entry';
			}

			if (l > HUF_DECBITS) {
				var pl = hdecod[(c >> (l - HUF_DECBITS))];

				if (pl.len) {
					throw 'Invalid table entry';
				}

				pl.lit++;

				if (pl.p) {
					var p = pl.p;
					pl.p = new Array(pl.lit);

					for (var i = 0; i < pl.lit - 1; ++i) {
						pl.p[i] = p[i];
					}
				} else {
					pl.p = new Array(1);
				}

				pl.p[pl.lit - 1] = im;
			} else if (l) {
				var plOffset = 0;

				for (var i = 1 << (HUF_DECBITS - l); i > 0; i--) {
					var pl = hdecod[(c << (HUF_DECBITS - l)) + plOffset];

					if (pl.len || pl.p) {
						throw 'Invalid table entry';
					}

					pl.len = l;
					pl.lit = im;

					plOffset++;
				}
			}
		}

		return true;
	}

	function getChar(c, lc, inDataView, inOffset) {
		c = (c << 8) | parseUint8DataView(inDataView, inOffset);
		lc += 8;

		return { c: c, lc: lc };
	}

	function getCode(po, rlc, c, lc, inDataView, inOffset, outBuffer, outBufferOffset, outBufferEndOffset) {
		if (po == rlc) {
			if (lc < 8) {
				var temp = getChar(c, lc, inDataView, inOffset);
				c = temp.c;
				lc = temp.lc;
			}

			lc -= 8;

			var cs = (c >> lc);

			if (out + cs > oe) {
				throw 'Issue with getCode';
			}

			var s = out[-1];

			while (cs-- > 0) {
				outBuffer[outBufferOffset.value++] = s;
			}
		} else if (outBufferOffset.value < outBufferEndOffset) {
			outBuffer[outBufferOffset.value++] = po;
		} else {
			throw 'Issue with getCode';
		}

		return { c: c, lc: lc };
	}

	var NBITS = 16;
	var A_OFFSET = 1 << (NBITS - 1);
	var M_OFFSET = 1 << (NBITS - 1);
	var MOD_MASK = (1 << NBITS) - 1;

	function UInt16(value) {
		return (value & 0xFFFF);
	};

	function Int16(value) {
		var ref = UInt16(value);
		return (ref > 0x7FFF) ? ref - 0x10000 : ref;
	};

	function wdec14(l, h) {
		var ls = Int16(l);
		var hs = Int16(h);

		var hi = hs;
		var ai = ls + (hi & 1) + (hi >> 1);

		var as = ai;
		var bs = ai - hi;

		return {a: as, b: bs}
	}

	function wav2Decode(j, buffer, nx, ox, ny, oy, mx) {
		var n = (nx > ny) ? ny : nx;
		var p = 1;
		var p2;

		while (p <= n) p <<= 1;

		p >>= 1;
		p2 = p;
		p >>= 1;

		while (p >= 1) {
			var py = 0;
			var ey = py + oy * (ny - p2);
			var oy1 = oy * p;
			var oy2 = oy * p2;
			var ox1 = ox * p;
			var ox2 = ox * p2;
			var i00, i01, i10, i11;

			for (; py <= ey; py += oy2) {
				var px = py;
				var ex = py + ox * (nx - p2);

				for (; px <= ex; px += ox2) {
					var p01 = px + ox1;
					var p10 = px + oy1;
					var p11 = p10 + ox1;

					var tmp = wdec14(buffer[px + j], buffer[p10 + j]);
					i00 = tmp.a;
					i10 = tmp.b;

					var tmp = wdec14(buffer[p01 + j], buffer[p11 + j]);
					i01 = tmp.a;
					i11 = tmp.b;

					var tmp = wdec14(i00, i01);
					buffer[px + j] = tmp.a;
					buffer[p01 + j] = tmp.b;

					var tmp = wdec14(i10, i11);
					buffer[p10 + j] = tmp.a;
					buffer[p11 + j] = tmp.b;
				}

				if (nx & p) {
					var p10 = px + oy1;

					var tmp = wdec14(buffer[px + j], buffer[p10 + j]);
					i00 = tmp.a;
					buffer[p10 + j] = tmp.b;

					buffer[px + j] = i00;
				}
			}

			if (ny & p) {
				var px = py;
				var ex = py + ox * (nx - p2);

				for (; px <= ex; px += ox2) {
					var p01 = px + ox1;

					var tmp = wdec14(buffer[px + j], buffer[p01 + j]);
					i00 = tmp.a;
					buffer[p01 + j] = tmp.b;

					buffer[px + j] = i00;
				}
			}

			p2 = p;
			p >>= 1;
		}

		return py;
	}

	function hufDecode(encodingTable, decodingTable, inBuffer, inOffset, ni, rlc, no, outBuffer, outOffset) {
		var c = 0;
		var lc = 0;
		var outBufferEndOffset = no;
		var inOffsetEnd = parseInt(inOffset.value + (ni + 7) / 8);

		var dataView = new DataView(inBuffer);

		while (inOffset.value < inOffsetEnd) {
			var temp = getChar(c, lc, dataView, inOffset);
			c = temp.c;
			lc = temp.lc;

			while (lc >= HUF_DECBITS) {
				var index = (c >> (lc - HUF_DECBITS)) & HUF_DECMASK;
				var pl = decodingTable[index];

				if (pl.len) {
					lc -= pl.len;
					var temp = getCode(pl.lit, rlc, c, lc, dataView, inOffset, outBuffer, outOffset, outBufferEndOffset);
					c = temp.c;
					lc = temp.lc;
				} else {
					if (!pl.p) {
						throw 'hufDecode issues';
					}

					var j;

					for (j = 0; j < pl.lit; j++) {
						var l = hufLength(encodingTable[pl.p[j]]);

						while (lc < l && inOffset.value < inOffsetEnd) {
							var temp = getChar(c, lc, dataView, inOffset);
							c = temp.c;
							lc = temp.lc;
						}

						if (lc >= l) {
							if (hufCode(encodingTable[pl.p[j]]) ==
								((c >> (lc - l)) & ((1 << l) - 1))) {

								lc -= l;
								var temp = getCode(pl.p[j], rlc, c, lc, dataView, inOffset, outBuffer, outOffset, outBufferEndOffset);
								c = temp.c;
								lc = temp.lc;
								break;
							}
						}
					}

					if (j == pl.lit) {
						throw 'hufDecode issues';
					}
				}
			}
		}

		var i = (8 - ni) & 7;
		c >>= i;
		lc -= i;

		while (lc > 0) {
			var pl = decodingTable[(c << (HUF_DECBITS - lc)) & HUF_DECMASK];

			if (pl.len) {
				lc -= pl.len;
				var temp = getCode(pl.lit, rlc, c, lc, dataView, inOffset, outBuffer, outOffset, outBufferEndOffset);
				c = temp.c;
				lc = temp.lc;
			} else {
				throw 'hufDecode issues';
			}
		}

		return true;
	}

	function hufUncompress(inBuffer, inOffset, nCompressed, outBuffer, outOffset, nRaw) {
		var initialInOffset = inOffset.value;

		var im = parseUint32(inBuffer, inOffset);
		var iM = parseUint32(inBuffer, inOffset);
		inOffset.value += 4;
		var nBits = parseUint32(inBuffer, inOffset);
		inOffset.value += 4;

		if (im < 0 || im >= HUF_ENCSIZE || iM < 0 || iM >= HUF_ENCSIZE) {
			throw 'Something wrong with HUF_ENCSIZE';
		}

		var freq = new Array(HUF_ENCSIZE);
		var hdec = new Array(HUF_DECSIZE);

		hufClearDecTable(hdec);

		var ni = nCompressed - (inOffset.value - initialInOffset);

		hufUnpackEncTable(inBuffer, inOffset, ni, im, iM, freq);

		if (nBits > 8 * (nCompressed - (inOffset.value - initialInOffset))) {
			throw 'Something wrong with hufUncompress';
		}

		hufBuildDecTable(freq, im, iM, hdec);

		hufDecode(freq, hdec, inBuffer, inOffset, nBits, iM, nRaw, outBuffer, outOffset);
	}

	function applyLut(lut, data, nData) {
		for (var i = 0; i < nData; ++i) {
			data[i] = lut[data[i]];
		}
	}

	function decompressPIZ(outBuffer, outOffset, inBuffer, inOffset, tmpBufSize, num_channels, exrChannelInfos, dataWidth, num_lines) {
		var bitmap = new Uint8Array(BITMAP_SIZE);

		var minNonZero = parseUint16(inBuffer, inOffset);
		var maxNonZero = parseUint16(inBuffer, inOffset);

		if (maxNonZero >= BITMAP_SIZE) {
			throw 'Something is wrong with PIZ_COMPRESSION BITMAP_SIZE'
		}

		if (minNonZero <= maxNonZero) {
			for (var i = 0; i < maxNonZero - minNonZero + 1; i++) {
				bitmap[i + minNonZero] = parseUint8(inBuffer, inOffset);
			}
		}

		var lut = new Uint16Array(USHORT_RANGE);
		var maxValue = reverseLutFromBitmap(bitmap, lut);

		var length = parseUint32(inBuffer, inOffset);

		hufUncompress(inBuffer, inOffset, length, outBuffer, outOffset, tmpBufSize);

		var pizChannelData = new Array(num_channels);

		var outBufferEnd = 0

		for (var i = 0; i < num_channels; i++) {
			var exrChannelInfo = exrChannelInfos[i];

			var pixelSize = 2; // assumes HALF_FLOAT

			pizChannelData[i] = {};
			pizChannelData[i]['start'] = outBufferEnd;
			pizChannelData[i]['end'] = pizChannelData[i]['start'];
			pizChannelData[i]['nx'] = dataWidth;
			pizChannelData[i]['ny'] = num_lines;
			pizChannelData[i]['size'] = 1;

			outBufferEnd += pizChannelData[i].nx * pizChannelData[i].ny * pizChannelData[i].size;
		}

		var fooOffset = 0;

		for (var i = 0; i < num_channels; i++) {
			for (var j = 0; j < pizChannelData[i].size; ++j) {
				fooOffset += wav2Decode(
				j + fooOffset,
				outBuffer,
				pizChannelData[i].nx,
				pizChannelData[i].size,
				pizChannelData[i].ny,
				pizChannelData[i].nx * pizChannelData[i].size,
				maxValue
				);
			}
		}

		applyLut(lut, outBuffer, outBufferEnd);

		return true;
	}

	function parseNullTerminatedString( buffer, offset ) {

		var uintBuffer = new Uint8Array( buffer );
		var endOffset = 0;

		while ( uintBuffer[ offset.value + endOffset ] != 0 ) {

			endOffset += 1;

		}

		var stringValue = new TextDecoder().decode(
			new Uint8Array( buffer ).slice( offset.value, offset.value + endOffset )
		);

		offset.value = offset.value + endOffset + 1;

		return stringValue;

	}

	function parseFixedLengthString( buffer, offset, size ) {

		var stringValue = new TextDecoder().decode(
			new Uint8Array( buffer ).slice( offset.value, offset.value + size )
		);

		offset.value = offset.value + size;

		return stringValue;

	}

	function parseUlong( buffer, offset ) {

		var uLong = new DataView( buffer.slice( offset.value, offset.value + 4 ) ).getUint32( 0, true );

		offset.value = offset.value + 8;

		return uLong;

	}

	function parseUint32( buffer, offset ) {

		var Uint32 = new DataView( buffer.slice( offset.value, offset.value + 4 ) ).getUint32( 0, true );

		offset.value = offset.value + 4;

		return Uint32;

	}

	function parseUint8DataView( dataView, offset ) {

		var Uint8 = dataView.getUint8(offset.value, true);

		offset.value = offset.value + 1;

		return Uint8;
	}

	function parseUint8( buffer, offset ) {

		var Uint8 = new DataView( buffer.slice( offset.value, offset.value + 1 ) ).getUint8( 0, true );

		offset.value = offset.value + 1;

		return Uint8;

	}

	function parseFloat32( buffer, offset ) {

		var float = new DataView( buffer.slice( offset.value, offset.value + 4 ) ).getFloat32( 0, true );

		offset.value += 4;

		return float;

	}

	// https://stackoverflow.com/questions/5678432/decompressing-half-precision-floats-in-javascript
	function decodeFloat16( binary ) {

		var exponent = ( binary & 0x7C00 ) >> 10,
			fraction = binary & 0x03FF;

		return ( binary >> 15 ? - 1 : 1 ) * (
			exponent ?
				(
					exponent === 0x1F ?
						fraction ? NaN : Infinity :
						Math.pow( 2, exponent - 15 ) * ( 1 + fraction / 0x400 )
				) :
				6.103515625e-5 * ( fraction / 0x400 )
		);

	}

	function parseUint16( buffer, offset ) {

		var Uint16 = new DataView( buffer.slice( offset.value, offset.value + 2 ) ).getUint16( 0, true );

		offset.value += 2;

		return Uint16;

	}

	function parseFloat16( buffer, offset ) {

		return decodeFloat16( parseUint16( buffer, offset) );

	}

	function parseChlist( buffer, offset, size ) {

		var startOffset = offset.value;
		var channels = [];

		while ( offset.value < ( startOffset + size - 1 ) ) {

			var name = parseNullTerminatedString( buffer, offset );
			var pixelType = parseUint32( buffer, offset ); // TODO: Cast this to UINT, HALF or FLOAT
			var pLinear = parseUint8( buffer, offset );
			offset.value += 3; // reserved, three chars
			var xSampling = parseUint32( buffer, offset );
			var ySampling = parseUint32( buffer, offset );

			channels.push( {
				name: name,
				pixelType: pixelType,
				pLinear: pLinear,
				xSampling: xSampling,
				ySampling: ySampling
			} );

		}

		offset.value += 1;

		return channels;

	}

	function parseChromaticities( buffer, offset ) {

		var redX = parseFloat32( buffer, offset );
		var redY = parseFloat32( buffer, offset );
		var greenX = parseFloat32( buffer, offset );
		var greenY = parseFloat32( buffer, offset );
		var blueX = parseFloat32( buffer, offset );
		var blueY = parseFloat32( buffer, offset );
		var whiteX = parseFloat32( buffer, offset );
		var whiteY = parseFloat32( buffer, offset );

		return { redX: redX, redY: redY, greenX, greenY, blueX, blueY, whiteX, whiteY };

	}

	function parseCompression( buffer, offset ) {

		var compressionCodes = [
			'NO_COMPRESSION',
			'RLE_COMPRESSION',
			'ZIPS_COMPRESSION',
			'ZIP_COMPRESSION',
			'PIZ_COMPRESSION'
		];

		var compression = parseUint8( buffer, offset );

		return compressionCodes[ compression ];

	}

	function parseBox2i( buffer, offset ) {

		var xMin = parseUint32( buffer, offset );
		var yMin = parseUint32( buffer, offset );
		var xMax = parseUint32( buffer, offset );
		var yMax = parseUint32( buffer, offset );

		return { xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax };

	}

	function parseLineOrder( buffer, offset ) {

		var lineOrders = [
			'INCREASING_Y'
		];

		var lineOrder = parseUint8( buffer, offset );

		return lineOrders[ lineOrder ];

	}

	function parseV2f( buffer, offset ) {

		var x = parseFloat32( buffer, offset );
		var y = parseFloat32( buffer, offset );

		return [ x, y ];

	}

	function parseValue( buffer, offset, type, size ) {

		if ( type == 'string' || type == 'iccProfile' ) {

			return parseFixedLengthString( buffer, offset, size );

		} else if ( type == 'chlist' ) {

			return parseChlist( buffer, offset, size );

		} else if ( type == 'chromaticities' ) {

			return parseChromaticities( buffer, offset );

		} else if ( type == 'compression' ) {

			return parseCompression( buffer, offset );

		} else if ( type == 'box2i' ) {

			return parseBox2i( buffer, offset );

		} else if ( type == 'lineOrder' ) {

			return parseLineOrder( buffer, offset );

		} else if ( type == 'float' ) {

			return parseFloat32( buffer, offset );

		} else if ( type == 'v2f' ) {

			return parseV2f( buffer, offset );

		} else {

			throw 'Cannot parse value for unsupported type: ' + type;

		}

	}

	var EXRHeader = {};

	var magic = new DataView( buffer ).getUint32( 0, true );
	var versionByteZero = new DataView( buffer ).getUint8( 4, true );
	var fullMask = new DataView( buffer ).getUint8( 5, true );

	// start of header

	var offset = { value: 8 }; // start at 8, after magic stuff

	var keepReading = true;

	while ( keepReading ) {

		var attributeName = parseNullTerminatedString( buffer, offset );

		if ( attributeName == 0 ) {

			keepReading = false;

		} else {

			var attributeType = parseNullTerminatedString( buffer, offset );
			var attributeSize = parseUint32( buffer, offset );
			var attributeValue = parseValue( buffer, offset, attributeType, attributeSize );

			EXRHeader[ attributeName ] = attributeValue;

		}

	}

	// offsets

	var dataWindowHeight = EXRHeader.dataWindow.yMax + 1;
	var scanlineBlockSize = 1; // 1 for NO_COMPRESSION
	if (EXRHeader.compression == 'PIZ_COMPRESSION') {
		scanlineBlockSize = 32;
	}
	var numBlocks = dataWindowHeight / scanlineBlockSize;

	for ( var i = 0; i < numBlocks; i ++ ) {

		var scanlineOffset = parseUlong( buffer, offset );

	}

	// we should be passed the scanline offset table, start reading pixel data

	var width = EXRHeader.dataWindow.xMax - EXRHeader.dataWindow.xMin + 1;
	var height = EXRHeader.dataWindow.yMax - EXRHeader.dataWindow.yMin + 1;
	var numChannels = EXRHeader.channels.length;

	var byteArray = new Float32Array( width * height * numChannels );

	var channelOffsets = {
		R: 0,
		G: 1,
		B: 2,
		A: 3
	};

	if (EXRHeader.compression == 'NO_COMPRESSION') {

		for ( var y = 0; y < height; y ++ ) {

			var y_scanline = parseUint32( buffer, offset );
			var dataSize = parseUint32( buffer, offset );

			for ( var channelID = 0; channelID < EXRHeader.channels.length; channelID ++ ) {

				var cOff = channelOffsets[ EXRHeader.channels[ channelID ].name ];

				if ( EXRHeader.channels[ channelID ].pixelType == 1 ) {

					// HALF
					for ( var x = 0; x < width; x ++ ) {

						var val = parseFloat16( buffer, offset );

						byteArray[ ( ( ( width - y_scanline ) * ( height * numChannels ) ) + ( x * numChannels ) ) + cOff ] = val;

					}

				} else {

					throw 'Only supported pixel format is HALF';

				}

			}

		}

	} else if (EXRHeader.compression == 'PIZ_COMPRESSION') {

		for ( var scanlineBlockIdx = 0; scanlineBlockIdx < height / scanlineBlockSize; scanlineBlockIdx++ ) {

			var line_no = parseUint32( buffer, offset );
			var data_len = parseUint32( buffer, offset );

			var tmpBufferSize = width * scanlineBlockSize * (EXRHeader.channels.length * BYTES_PER_HALF);
			var tmpBuffer = new Uint16Array(tmpBufferSize);
	  	var tmpOffset = { value: 0 };

			decompressPIZ(tmpBuffer, tmpOffset, buffer, offset, tmpBufferSize, numChannels, EXRHeader.channels, width, scanlineBlockSize);

			for ( var line_y = 0; line_y < scanlineBlockSize; line_y ++ ) {

				for ( var channelID = 0; channelID < EXRHeader.channels.length; channelID ++ ) {

					var cOff = channelOffsets[ EXRHeader.channels[ channelID ].name ];

					if ( EXRHeader.channels[ channelID ].pixelType == 1 ) {

						// HALF
						for ( var x = 0; x < width; x ++ ) {

							var val = decodeFloat16(tmpBuffer[ (channelID * (scanlineBlockSize * width)) + (line_y * width) + x ]);

							var true_y = line_y + (scanlineBlockIdx * scanlineBlockSize);

							byteArray[ ( ( (height - true_y) * ( width * numChannels ) ) + ( x * numChannels ) ) + cOff ] = val;

						}

					} else {

						throw 'Only supported pixel format is HALF';

					}

				}

			}

		}

	} else {

		throw 'Cannot decompress unsupported compression';

	}

	return {
		header: EXRHeader,
		width: width,
		height: height,
		data: byteArray,
		format: THREE.RGBFormat,
		type: THREE.FloatType
	};

};
