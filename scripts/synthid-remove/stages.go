package main

import (
	"bytes"
	"image/jpeg"
	"math"
	"math/cmplx"
	"math/rand"
)

// ---------------------------------------------------------------------------
// SynthID carrier frequencies
// ---------------------------------------------------------------------------

// V4 universal carrier bins for 1024×1024 reference image.
var v4Carriers = [][2]int{
	{14, 14}, {14, -14}, {-14, 14}, {-14, -14},
	{98, 14}, {98, -14}, {-98, 14}, {-98, -14},
	{126, 14}, {126, -14}, {-126, 14}, {-126, -14},
	{128, 128}, {128, -128}, {-128, 128}, {-128, -128},
	{210, 14}, {210, -14}, {-210, 14}, {-210, -14},
	{238, 14}, {238, -14}, {-238, 14}, {-238, -14},
}

// V3 carriers for 512×512 reference image.
var v3Carriers = [][2]int{
	{48, 0}, {-48, 0}, {96, 0}, {-96, 0}, {192, 0}, {-192, 0},
	{210, 0}, {-210, 0}, {238, 0}, {-238, 0},
	{0, 88}, {0, -88}, {0, 176}, {0, -176}, {0, 192}, {0, -192},
	{48, 88}, {-48, -88}, {48, -88}, {-48, 88},
	{96, 88}, {-96, -88}, {96, -88}, {-96, 88},
	{96, 176}, {-96, -176}, {96, -176}, {-96, 176},
}

const v4RefSize = 1024.0
const v3RefSize = 512.0

// ---------------------------------------------------------------------------
// Stage 1 (placeholder): VAE round-trip
// ---------------------------------------------------------------------------

// vaeRoundTrip is a placeholder for future VAE-based watermark removal.
// When PyTorch + sd-vae-ft-mse is available, this would encode/decode the
// image through the VAE to project it off the natural-image manifold.
// Currently a no-op.
func vaeRoundTrip(img *FloatImage, passes int) *FloatImage {
	return img
}

// ---------------------------------------------------------------------------
// Stage 2: Elastic deformation
// ---------------------------------------------------------------------------

// elasticDeform applies a smooth low-frequency random warp field to fragment
// the watermark's spatial phase consensus (the "collage effect").
// sigmaFactor controls the smoothness: smaller = more high-frequency content
// in the displacement field = better watermark fragmentation.
func elasticDeform(img *FloatImage, alpha float64, sigmaFactor float64) *FloatImage {
	if alpha <= 0 {
		out := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
		copy(out.Data, img.Data)
		return out
	}

	// Generate random displacement fields
	dispX := make([]float64, img.W*img.H)
	dispY := make([]float64, img.W*img.H)
	for i := range dispX {
		dispX[i] = (rand.Float64() - 0.5) * 2 * alpha
		dispY[i] = (rand.Float64() - 0.5) * 2 * alpha
	}

	// Smooth with Gaussian blur for low-frequency field
	// sigmaFactor controls smoothness: 20.0 = very smooth, 50.0 = more high-freq
	sigma := float64(img.W) / sigmaFactor
	if sigma < 5 {
		sigma = 5
	}
	dispX = gaussianBlur1D(dispX, img.W, img.H, sigma)
	dispY = gaussianBlur1D(dispY, img.W, img.H, sigma)

	// Apply displacement
	result := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
	for y := 0; y < img.H; y++ {
		for x := 0; x < img.W; x++ {
			idx := y*img.W + x
			sx := float64(x) + dispX[idx]
			sy := float64(y) + dispY[idx]
			for c := 0; c < 3; c++ {
				result.Set(x, y, c, bicubicSample(img, sx, sy, c))
			}
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Stage 3: Global geometric combo (rotation + zoom + shift)
// ---------------------------------------------------------------------------

// geometricCombo applies a small rotation, zoom, and pixel shift in a single
// affine warp to break the watermark's geometric alignment.
func geometricCombo(img *FloatImage, rotDeg, zoom float64, shiftPx int) *FloatImage {
	rotRad := rotDeg * math.Pi / 180.0
	cos := math.Cos(rotRad) / zoom
	sin := math.Sin(rotRad) / zoom
	cx := float64(img.W) / 2.0
	cy := float64(img.H) / 2.0
	sx := float64(shiftPx) * (rand.Float64()*2 - 1)
	sy := float64(shiftPx) * (rand.Float64()*2 - 1)

	result := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
	for y := 0; y < img.H; y++ {
		for x := 0; x < img.W; x++ {
			// Inverse transform: find source pixel
			dx := float64(x) - cx - sx
			dy := float64(y) - cy - sy
			srcX := cos*dx + sin*dy + cx
			srcY := -sin*dx + cos*dy + cy
			for c := 0; c < 3; c++ {
				result.Set(x, y, c, bicubicSample(img, srcX, srcY, c))
			}
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Stage 4: Resize-squeeze (AREA downsample → bicubic upsample)
// ---------------------------------------------------------------------------

// resizeSqueeze downsamples then upsamples to erase sub-pixel watermark info.
func resizeSqueeze(img *FloatImage, ratio float64) *FloatImage {
	if ratio >= 1.0 {
		out := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
		copy(out.Data, img.Data)
		return out
	}
	newW := int(math.Round(float64(img.W) * ratio))
	newH := int(math.Round(float64(img.H) * ratio))
	if newW < 2 {
		newW = 2
	}
	if newH < 2 {
		newH = 2
	}
	small := areaDownsample(img, newW, newH)
	return bicubicUpsample(small, img.W, img.H)
}

// ---------------------------------------------------------------------------
// Stage 5: Color-contrast nudge (HSV micro-shift)
// ---------------------------------------------------------------------------

// colorNudge applies small random brightness, contrast, and saturation shifts
// to alter per-pixel statistics SynthID keys on.
func colorNudge(img *FloatImage, amount float64) *FloatImage {
	bShift := (rand.Float64()*2 - 1) * amount
	cShift := (rand.Float64()*2 - 1) * amount
	sShift := (rand.Float64()*2 - 1) * amount

	// Compute per-channel mean
	var mean [3]float64
	for i := 0; i < len(img.Data); i += 3 {
		mean[0] += img.Data[i]
		mean[1] += img.Data[i+1]
		mean[2] += img.Data[i+2]
	}
	n := float64(len(img.Data) / 3)
	mean[0] /= n
	mean[1] /= n
	mean[2] /= n

	result := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
	for i := 0; i < len(img.Data); i += 3 {
		gray := (img.Data[i] + img.Data[i+1] + img.Data[i+2]) / 3.0
		for c := 0; c < 3; c++ {
			v := img.Data[i+c]
			// Brightness
			v = v * (1 + bShift)
			// Contrast
			v = (v - mean[c]) * (1 + cShift) + mean[c]
			// Saturation
			v = gray + (v-gray)*(1+sShift)
			result.Data[i+c] = clamp01(v)
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Stage 6: Residual-phase FFT carrier scrambling
// ---------------------------------------------------------------------------

// fftCarrierScramble performs 2D FFT on each channel and scrambles the phase
// at known SynthID carrier frequencies to break watermark coherence.
func fftCarrierScramble(img *FloatImage, strength float64, radius int) *FloatImage {
	H, W := img.H, img.W
	Hp := nextPow2(H)
	Wp := nextPow2(W)

	result := &FloatImage{W: W, H: H, Data: make([]float64, len(img.Data))}

	for c := 0; c < 3; c++ {
		// Extract channel and edge-pad to power-of-2
		data := make([]complex128, Hp*Wp)
		for y := 0; y < Hp; y++ {
			for x := 0; x < Wp; x++ {
				sy := y
				sx := x
				if sy >= H {
					sy = H - 1
				}
				if sx >= W {
					sx = W - 1
				}
				data[y*Wp+x] = complex(img.At(sx, sy, c), 0)
			}
		}

		// 2D FFT
		fft2d(data, Hp, Wp)

		// Scramble carrier frequencies
		centerY := Hp / 2
		centerX := Wp / 2

		scrambleCarriers(data, Hp, Wp, centerY, centerX, v4Carriers, v4RefSize, strength, radius)
		scrambleCarriers(data, Hp, Wp, centerY, centerX, v3Carriers, v3RefSize, strength, radius)

		// Inverse 2D FFT
		ifft2d(data, Hp, Wp)

		// Extract real part and crop back
		for y := 0; y < H; y++ {
			for x := 0; x < W; x++ {
				v := real(data[y*Wp+x])
				result.Set(x, y, c, clamp01(v))
			}
		}
	}
	return result
}

// scrambleCarriers scrambles the phase at each carrier frequency bin and its
// neighborhood, maintaining conjugate symmetry for real output.
func scrambleCarriers(data []complex128, Hp, Wp, centerY, centerX int,
	carriers [][2]int, refSize float64, strength float64, radius int) {

	for _, car := range carriers {
		fy := int(math.Round(float64(car[0])*float64(Hp)/refSize)) + centerY
		fx := int(math.Round(float64(car[1])*float64(Wp)/refSize)) + centerX

		for dy := -radius; dy <= radius; dy++ {
			for dx := -radius; dx <= radius; dx++ {
				ny := fy + dy
				nx := fx + dx
				if ny < 0 || ny >= Hp || nx < 0 || nx >= Wp {
					continue
				}

				mag := cmplx.Abs(data[ny*Wp+nx])
				if mag < 1e-15 {
					continue
				}
				origPhase := cmplx.Phase(data[ny*Wp+nx])
				randomPhase := rand.Float64() * 2 * math.Pi
				newPhase := origPhase*(1-strength) + randomPhase*strength
				data[ny*Wp+nx] = complex(mag*math.Cos(newPhase), mag*math.Sin(newPhase))

				// Set conjugate to maintain real output
				cny := Hp - ny
				cnx := Wp - nx
				if cny >= 0 && cny < Hp && cnx >= 0 && cnx < Wp {
					cmag := cmplx.Abs(data[cny*Wp+cnx])
					data[cny*Wp+cnx] = complex(cmag*math.Cos(-newPhase), cmag*math.Sin(-newPhase))
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Stage 7a: JPEG chain
// ---------------------------------------------------------------------------

// jpegChain applies multiple JPEG compression/decompression cycles at varying
// qualities to disrupt watermark through quantization artifacts.
func jpegChain(img *FloatImage, qualities []int) *FloatImage {
	current := img
	for _, q := range qualities {
		current = jpegCompressOnce(current, q)
	}
	return current
}

func jpegCompressOnce(img *FloatImage, quality int) *FloatImage {
	rgba := toRGBA(img)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, rgba, &jpeg.Options{Quality: quality}); err != nil {
		return img
	}
	decoded, err := jpeg.Decode(&buf)
	if err != nil {
		return img
	}
	return toFloatImage(decoded)
}

// ---------------------------------------------------------------------------
// Stage 7b: Luminance noise
// ---------------------------------------------------------------------------

// addLumaNoise adds small Gaussian noise to the luminance channel.
func addLumaNoise(img *FloatImage, sigma float64) *FloatImage {
	if sigma <= 0 {
		out := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
		copy(out.Data, img.Data)
		return out
	}
	result := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
	s := sigma / 255.0
	for i := 0; i < len(img.Data); i += 3 {
		noise := rand.NormFloat64() * s
		for c := 0; c < 3; c++ {
			result.Data[i+c] = clamp01(img.Data[i+c] + noise)
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Stage 7c: Bilateral filter
// ---------------------------------------------------------------------------

// bilateralFilter applies an edge-preserving bilateral filter.
func bilateralFilter(img *FloatImage, d int, sigmaColor, sigmaSpace float64) *FloatImage {
	if d < 1 {
		out := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
		copy(out.Data, img.Data)
		return out
	}
	radius := d / 2
	if radius < 1 {
		radius = 1
	}

	// Precompute spatial weights
	spatialW := make([][]float64, 2*radius+1)
	for i := range spatialW {
		spatialW[i] = make([]float64, 2*radius+1)
		for j := range spatialW[i] {
			dy := float64(i - radius)
			dx := float64(j - radius)
			spatialW[i][j] = math.Exp(-(dx*dx + dy*dy) / (2 * sigmaSpace * sigmaSpace))
		}
	}

	result := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
	twoSigmaC2 := 2 * sigmaColor * sigmaColor

	for y := 0; y < img.H; y++ {
		for x := 0; x < img.W; x++ {
			for c := 0; c < 3; c++ {
				center := img.At(x, y, c)
				var wSum, vSum float64
				for dy := -radius; dy <= radius; dy++ {
					ny := y + dy
					if ny < 0 {
						ny = 0
					}
					if ny >= img.H {
						ny = img.H - 1
					}
					for dx := -radius; dx <= radius; dx++ {
						nx := x + dx
						if nx < 0 {
							nx = 0
						}
						if nx >= img.W {
							nx = img.W - 1
						}
						v := img.At(nx, ny, c)
						colorDiff := v - center
						w := spatialW[dy+radius][dx+radius] * math.Exp(-(colorDiff*colorDiff)/twoSigmaC2)
						wSum += w
						vSum += v * w
					}
				}
				result.Set(x, y, c, vSum/wSum)
			}
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Stage 6b: Broadband FFT phase scrambling
// ---------------------------------------------------------------------------

// broadbandFFTScramble scrambles phases across a broad frequency band (not just
// known carriers) to break watermarks whose carrier positions are unknown.
// minFreq and maxFreq are fractions of Nyquist (0-1).
func broadbandFFTScramble(img *FloatImage, strength float64, minFreq, maxFreq float64) *FloatImage {
	H, W := img.H, img.W
	Hp := nextPow2(H)
	Wp := nextPow2(W)

	result := &FloatImage{W: W, H: H, Data: make([]float64, len(img.Data))}
	centerY := Hp / 2
	centerX := Wp / 2
	maxR := math.Sqrt(float64(centerY*centerY + centerX*centerX))
	minR := minFreq * maxR
	maxRF := maxFreq * maxR

	for c := 0; c < 3; c++ {
		// Extract channel and edge-pad to power-of-2
		data := make([]complex128, Hp*Wp)
		for y := 0; y < Hp; y++ {
			for x := 0; x < Wp; x++ {
				sy := y
				sx := x
				if sy >= H {
					sy = H - 1
				}
				if sx >= W {
					sx = W - 1
				}
				data[y*Wp+x] = complex(img.At(sx, sy, c), 0)
			}
		}

		// 2D FFT
		fft2d(data, Hp, Wp)

		// Scramble phases in the frequency band
		for fy := 0; fy < Hp; fy++ {
			dy := float64(fy - centerY)
			for fx := 0; fx < Wp; fx++ {
				dx := float64(fx - centerX)
				r := math.Sqrt(dx*dx + dy*dy)
				if r < minR || r > maxRF {
					continue
				}
				// Skip DC
				if fy == centerY && fx == centerX {
					continue
				}

				mag := cmplx.Abs(data[fy*Wp+fx])
				if mag < 1e-15 {
					continue
				}
				origPhase := cmplx.Phase(data[fy*Wp+fx])
				randomPhase := rand.Float64() * 2 * math.Pi
				newPhase := origPhase*(1-strength) + randomPhase*strength
				data[fy*Wp+fx] = complex(mag*math.Cos(newPhase), mag*math.Sin(newPhase))

				// Maintain conjugate symmetry
				cny := Hp - fy
				cnx := Wp - fx
				if cny >= 0 && cny < Hp && cnx >= 0 && cnx < Wp && (cny != fy || cnx != fx) {
					cmag := cmplx.Abs(data[cny*Wp+cnx])
					data[cny*Wp+cnx] = complex(cmag*math.Cos(-newPhase), cmag*math.Sin(-newPhase))
				}
			}
		}

		// Inverse 2D FFT
		ifft2d(data, Hp, Wp)

		// Extract real part and crop back
		for y := 0; y < H; y++ {
			for x := 0; x < W; x++ {
				v := real(data[y*Wp+x])
				result.Set(x, y, c, clamp01(v))
			}
		}
	}
	return result
}


// unsharpMask applies unsharp masking to counteract blurriness introduced by
// the bilateral filter and interpolation stages.
// sharpened = original + amount * (original - gaussian_blurred)
func unsharpMask(img *FloatImage, sigma float64, amount float64) *FloatImage {
	if sigma <= 0 || amount <= 0 {
		out := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
		copy(out.Data, img.Data)
		return out
	}

	result := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}

	for c := 0; c < 3; c++ {
		// Extract channel
		channel := make([]float64, img.W*img.H)
		for y := 0; y < img.H; y++ {
			for x := 0; x < img.W; x++ {
				channel[y*img.W+x] = img.At(x, y, c)
			}
		}

		// Gaussian blur
		blurred := gaussianBlur1D(channel, img.W, img.H, sigma)

		// Unsharp mask
		for y := 0; y < img.H; y++ {
			for x := 0; x < img.W; x++ {
				idx := y*img.W + x
				sharpened := channel[idx] + amount*(channel[idx]-blurred[idx])
				result.Data[(y*img.W+x)*3+c] = clamp01(sharpened)
			}
		}
	}

	return result
}

// ---------------------------------------------------------------------------
// Stage 8b: Grid snap (force-sync close colors to block sample)
// ---------------------------------------------------------------------------

// gridSnap places a sample point at the center of each gridSize×gridSize block.
// The sample color is the block's mean color. For each pixel, if its color is
// within colorThreshold of the nearest sample point's color, the pixel is
// forced to exactly match the sample color. This eliminates subtle per-pixel
// watermark noise by snapping to reference colors.
//
// When multiple sample points could modify a pixel, the spatially nearest one
// takes priority. Pixels whose color differs too much from all nearby samples
// (edges, details) are left untouched.
func gridSnap(img *FloatImage, gridSize int, colorThreshold float64) *FloatImage {
	if gridSize < 1 || colorThreshold <= 0 {
		out := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
		copy(out.Data, img.Data)
		return out
	}

	bw := (img.W + gridSize - 1) / gridSize
	bh := (img.H + gridSize - 1) / gridSize
	half := float64(gridSize) / 2.0

	// Step 1: Compute block means (sample colors)
	samples := make([][3]float64, bw*bh)
	sampleX := make([]float64, bw*bh) // sample point x position
	sampleY := make([]float64, bw*bh) // sample point y position

	for by := 0; by < bh; by++ {
		for bx := 0; bx < bw; bx++ {
			var sum [3]float64
			var count float64
			yStart := by * gridSize
			xStart := bx * gridSize
			yEnd := yStart + gridSize
			xEnd := xStart + gridSize
			if yEnd > img.H {
				yEnd = img.H
			}
			if xEnd > img.W {
				xEnd = img.W
			}
			for y := yStart; y < yEnd; y++ {
				for x := xStart; x < xEnd; x++ {
					for c := 0; c < 3; c++ {
						sum[c] += img.At(x, y, c)
					}
					count++
				}
			}
			idx := by*bw + bx
			if count > 0 {
				for c := 0; c < 3; c++ {
					samples[idx][c] = sum[c] / count
				}
			}
			// Sample point at block center
			sampleX[idx] = float64(xStart) + half
			sampleY[idx] = float64(yStart) + half
		}
	}

	// Step 2: For each pixel, find nearest sample with matching color and snap
	result := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
	copy(result.Data, img.Data)

	for y := 0; y < img.H; y++ {
		// Candidate blocks: own block ± 1
		byCenter := int(float64(y)/float64(gridSize))
		for x := 0; x < img.W; x++ {
			bxCenter := int(float64(x)/float64(gridSize))

			var bestDist float64 = math.MaxFloat64
			var bestSample *[3]float64

			// Search 3x3 neighborhood of blocks
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					cy := byCenter + dy
					cx := bxCenter + dx
					if cy < 0 || cy >= bh || cx < 0 || cx >= bw {
						continue
					}
					idx := cy*bw + cx

					// Spatial distance from pixel to sample point
					sdx := float64(x) - sampleX[idx]
					sdy := float64(y) - sampleY[idx]
					spatialDist := math.Sqrt(sdx*sdx + sdy*sdy)

					// Color distance from pixel to sample color
					var colorDist float64
					for c := 0; c < 3; c++ {
						d := img.At(x, y, c) - samples[idx][c]
						colorDist += d * d
					}
					colorDist = math.Sqrt(colorDist / 3.0)

					// Only consider if color is close enough
					if colorDist < colorThreshold && spatialDist < bestDist {
						bestDist = spatialDist
						s := samples[idx]
						bestSample = &s
					}
				}
			}

			// Snap to nearest matching sample
			if bestSample != nil {
				for c := 0; c < 3; c++ {
					result.Set(x, y, c, (*bestSample)[c])
				}
			}
		}
	}

	return result
}

// ---------------------------------------------------------------------------
// Stage 9: 8x8 block color smoothing
// ---------------------------------------------------------------------------

// blockColorSmooth divides the image into blockSize×blockSize blocks and uses
// block-level color statistics to guide per-pixel smoothing. Unlike a naive
// block-replacement approach, this method:
//  1. Computes block means and their similarity-weighted neighborhood averages
//  2. Bilinearly interpolates between block averages to get a per-pixel "target"
//  3. Blends each pixel towards its target based on per-pixel color distance
//
// This removes pixel-level watermark noise in smooth areas (where pixels are
// close to the local average) while preserving edges and details (where pixels
// deviate significantly from the average). No block boundaries are visible.
//
// threshold is the max per-pixel color distance for smoothing to apply.
// strength controls how aggressively pixels are pulled towards the target (0-1).
func blockColorSmooth(img *FloatImage, blockSize int, threshold float64, strength float64) *FloatImage {
	if blockSize < 1 || threshold <= 0 || strength <= 0 {
		out := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
		copy(out.Data, img.Data)
		return out
	}

	bw := (img.W + blockSize - 1) / blockSize
	bh := (img.H + blockSize - 1) / blockSize

	// Step 1: Compute block means
	blockMeans := make([][3]float64, bw*bh)
	for by := 0; by < bh; by++ {
		for bx := 0; bx < bw; bx++ {
			var sum [3]float64
			var count float64
			yStart := by * blockSize
			xStart := bx * blockSize
			yEnd := yStart + blockSize
			xEnd := xStart + blockSize
			if yEnd > img.H {
				yEnd = img.H
			}
			if xEnd > img.W {
				xEnd = img.W
			}
			for y := yStart; y < yEnd; y++ {
				for x := xStart; x < xEnd; x++ {
					for c := 0; c < 3; c++ {
						sum[c] += img.At(x, y, c)
					}
					count++
				}
			}
			if count > 0 {
				for c := 0; c < 3; c++ {
					blockMeans[by*bw+bx][c] = sum[c] / count
				}
			}
		}
	}

	// Step 2: For each block, compute smoothed mean using similar neighbors
	smoothedMeans := make([][3]float64, bw*bh)
	for by := 0; by < bh; by++ {
		for bx := 0; bx < bw; bx++ {
			idx := by*bw + bx
			var sum [3]float64
			var weightSum float64

			for ny := -1; ny <= 1; ny++ {
				for nx := -1; nx <= 1; nx++ {
					cy := by + ny
					cx := bx + nx
					if cy < 0 || cy >= bh || cx < 0 || cx >= bw {
						continue
					}
					nidx := cy*bw + cx

					var dist float64
					for c := 0; c < 3; c++ {
						d := blockMeans[idx][c] - blockMeans[nidx][c]
						dist += d * d
					}
					dist = math.Sqrt(dist / 3.0)

					if dist < threshold*2 { // wider threshold for neighborhood averaging
						w := 1.0 - dist/(threshold*2)
						for c := 0; c < 3; c++ {
							sum[c] += blockMeans[nidx][c] * w
						}
						weightSum += w
					}
				}
			}

			if weightSum > 0 {
				for c := 0; c < 3; c++ {
					smoothedMeans[idx][c] = sum[c] / weightSum
				}
			} else {
				smoothedMeans[idx] = blockMeans[idx]
			}
		}
	}

	// Step 3: For each pixel, bilinearly interpolate smoothed block means and
	// blend towards the target based on per-pixel color distance.
	result := &FloatImage{W: img.W, H: img.H, Data: make([]float64, len(img.Data))}
	invBlockSize := 1.0 / float64(blockSize)
	invThreshold := 1.0 / threshold

	for y := 0; y < img.H; y++ {
		// Block-space y coordinate (centered on block centers)
		fy := (float64(y) + 0.5) * invBlockSize - 0.5
		by0 := int(math.Floor(fy))
		by1 := by0 + 1
		wy := fy - float64(by0)
		// Clamp
		if by0 < 0 {
			by0 = 0
			wy = 0
		}
		if by0 >= bh {
			by0 = bh - 1
			wy = 0
		}
		if by1 < 0 {
			by1 = 0
		}
		if by1 >= bh {
			by1 = bh - 1
		}

		for x := 0; x < img.W; x++ {
			fx := (float64(x) + 0.5) * invBlockSize - 0.5
			bx0 := int(math.Floor(fx))
			bx1 := bx0 + 1
			wx := fx - float64(bx0)
			if bx0 < 0 {
				bx0 = 0
				wx = 0
			}
			if bx0 >= bw {
				bx0 = bw - 1
				wx = 0
			}
			if bx1 < 0 {
				bx1 = 0
			}
			if bx1 >= bw {
				bx1 = bw - 1
			}

			// Bilinear interpolation of smoothed means
			m00 := smoothedMeans[by0*bw+bx0]
			m01 := smoothedMeans[by0*bw+bx1]
			m10 := smoothedMeans[by1*bw+bx0]
			m11 := smoothedMeans[by1*bw+bx1]

			var target [3]float64
			for c := 0; c < 3; c++ {
				top := m00[c]*(1-wx) + m01[c]*wx
				bot := m10[c]*(1-wx) + m11[c]*wx
				target[c] = top*(1-wy) + bot*wy
			}

			// Per-pixel color distance to target
			var dist float64
			for c := 0; c < 3; c++ {
				d := img.At(x, y, c) - target[c]
				dist += d * d
			}
			dist = math.Sqrt(dist / 3.0)

			// Blend amount: full smoothing when pixel matches target (smooth area),
			// no smoothing when pixel deviates significantly (edge/detail).
			var blendAmount float64
			if dist < threshold {
				blendAmount = (1.0 - dist*invThreshold) * strength
			}

			for c := 0; c < 3; c++ {
				orig := img.At(x, y, c)
				result.Set(x, y, c, orig*(1-blendAmount)+target[c]*blendAmount)
			}
		}
	}

	return result
}

