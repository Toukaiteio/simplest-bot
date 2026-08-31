package main

import (
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"os"
)

// FloatImage stores an RGB image as flat float64 data in [0,1] range.
type FloatImage struct {
	W, H int
	Data []float64 // len = W*H*3, interleaved RGB
}

func (img *FloatImage) At(x, y, c int) float64 {
	return img.Data[(y*img.W+x)*3+c]
}

func (img *FloatImage) Set(x, y, c int, v float64) {
	img.Data[(y*img.W+x)*3+c] = v
}

// loadImage reads an image file (PNG or JPEG).
func loadImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	img, _, err := image.Decode(f)
	return img, err
}

// saveImage writes an image to a file. Format is determined by extension.
func saveImage(img image.Image, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	// Determine format from extension
	ext := path[len(path)-4:]
	if ext == ".jpg" || ext == ".JPG" {
		return jpeg.Encode(f, img, &jpeg.Options{Quality: 95})
	}
	// Default to PNG
	return png.Encode(f, img)
}

// toFloatImage converts an image.Image to FloatImage.
func toFloatImage(img image.Image) *FloatImage {
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	f := &FloatImage{W: w, H: h, Data: make([]float64, w*h*3)}

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, b, _ := img.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			f.Data[(y*w+x)*3+0] = float64(r) / 65535.0
			f.Data[(y*w+x)*3+1] = float64(g) / 65535.0
			f.Data[(y*w+x)*3+2] = float64(b) / 65535.0
		}
	}
	return f
}

// toRGBA converts a FloatImage to *image.RGBA.
func toRGBA(img *FloatImage) *image.RGBA {
	rgba := image.NewRGBA(image.Rect(0, 0, img.W, img.H))
	for y := 0; y < img.H; y++ {
		for x := 0; x < img.W; x++ {
			r := img.At(x, y, 0)
			g := img.At(x, y, 1)
			b := img.At(x, y, 2)
			rgba.SetRGBA(x, y, color.RGBA{
				R: clamp8(r),
				G: clamp8(g),
				B: clamp8(b),
				A: 255,
			})
		}
	}
	return rgba
}

func clamp8(v float64) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 1 {
		return 255
	}
	return uint8(v*255 + 0.5)
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// catmullRom returns the 4 Catmull-Rom spline weights for fractional position t.
func catmullRom(t float64) [4]float64 {
	t2 := t * t
	t3 := t2 * t
	return [4]float64{
		-0.5*t + t2 - 0.5*t3,
		1 - 2.5*t2 + 1.5*t3,
		0.5*t + 2*t2 - 1.5*t3,
		-0.5*t2 + 0.5*t3,
	}
}

// bicubicSample samples a channel of the image at sub-pixel coordinates (x, y)
// using Catmull-Rom bicubic interpolation.
func bicubicSample(img *FloatImage, x, y float64, c int) float64 {
	// Clamp to valid range
	maxX := float64(img.W - 1)
	maxY := float64(img.H - 1)
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	if x > maxX {
		x = maxX
	}
	if y > maxY {
		y = maxY
	}

	ix := int(math.Floor(x))
	iy := int(math.Floor(y))
	fx := x - float64(ix)
	fy := y - float64(iy)

	wx := catmullRom(fx)
	wy := catmullRom(fy)

	var result float64
	for j := -1; j <= 2; j++ {
		yy := iy + j
		if yy < 0 {
			yy = 0
		}
		if yy >= img.H {
			yy = img.H - 1
		}

		var rowVal float64
		for i := -1; i <= 2; i++ {
			xx := ix + i
			if xx < 0 {
				xx = 0
			}
			if xx >= img.W {
				xx = img.W - 1
			}
			rowVal += img.At(xx, yy, c) * wx[i+1]
		}
		result += rowVal * wy[j+1]
	}

	return clamp01(result)
}

// areaDownsample downsamples an image using area-averaging (box filter).
func areaDownsample(img *FloatImage, newW, newH int) *FloatImage {
	result := &FloatImage{W: newW, H: newH, Data: make([]float64, newW*newH*3)}
	scaleX := float64(img.W) / float64(newW)
	scaleY := float64(img.H) / float64(newH)

	for y := 0; y < newH; y++ {
		y0 := int(math.Floor(float64(y) * scaleY))
		y1 := int(math.Ceil(float64(y+1) * scaleY))
		if y1 <= y0 {
			y1 = y0 + 1
		}
		if y1 > img.H {
			y1 = img.H
		}

		for x := 0; x < newW; x++ {
			x0 := int(math.Floor(float64(x) * scaleX))
			x1 := int(math.Ceil(float64(x+1) * scaleX))
			if x1 <= x0 {
				x1 = x0 + 1
			}
			if x1 > img.W {
				x1 = img.W
			}

			count := float64((y1 - y0) * (x1 - x0))
			for c := 0; c < 3; c++ {
				var sum float64
				for yy := y0; yy < y1; yy++ {
					for xx := x0; xx < x1; xx++ {
						sum += img.At(xx, yy, c)
					}
				}
				result.Set(x, y, c, sum/count)
			}
		}
	}
	return result
}

// bicubicUpsample upscales an image using bicubic interpolation.
func bicubicUpsample(img *FloatImage, newW, newH int) *FloatImage {
	result := &FloatImage{W: newW, H: newH, Data: make([]float64, newW*newH*3)}
	scaleX := float64(img.W-1) / float64(newW-1)
	scaleY := float64(img.H-1) / float64(newH-1)

	for y := 0; y < newH; y++ {
		for x := 0; x < newW; x++ {
			sx := float64(x) * scaleX
			sy := float64(y) * scaleY
			for c := 0; c < 3; c++ {
				result.Set(x, y, c, bicubicSample(img, sx, sy, c))
			}
		}
	}
	return result
}

// computePSNR computes PSNR between two images (data in [0,1]).
func computePSNR(a, b *FloatImage) float64 {
	if len(a.Data) != len(b.Data) {
		return 0
	}
	var mse float64
	for i := range a.Data {
		d := a.Data[i] - b.Data[i]
		mse += d * d
	}
	mse /= float64(len(a.Data))
	if mse == 0 {
		return math.Inf(1)
	}
	return 10.0 * math.Log10(1.0/mse)
}

// gaussianBlur1D applies a 1D Gaussian blur to a single-channel flat array.
func gaussianBlur1D(data []float64, w, h int, sigma float64) []float64 {
	if sigma < 0.1 {
		out := make([]float64, len(data))
		copy(out, data)
		return out
	}

	radius := int(math.Ceil(sigma * 3))
	if radius < 1 {
		radius = 1
	}

	// Build kernel
	kernel := make([]float64, 2*radius+1)
	var kSum float64
	for i := -radius; i <= radius; i++ {
		v := math.Exp(-float64(i*i) / (2 * sigma * sigma))
		kernel[i+radius] = v
		kSum += v
	}
	for i := range kernel {
		kernel[i] /= kSum
	}

	// Horizontal pass
	temp := make([]float64, len(data))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var v float64
			for k := -radius; k <= radius; k++ {
				xx := x + k
				if xx < 0 {
					xx = 0
				}
				if xx >= w {
					xx = w - 1
				}
				v += data[y*w+xx] * kernel[k+radius]
			}
			temp[y*w+x] = v
		}
	}

	// Vertical pass
	result := make([]float64, len(data))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var v float64
			for k := -radius; k <= radius; k++ {
				yy := y + k
				if yy < 0 {
					yy = 0
				}
				if yy >= h {
					yy = h - 1
				}
				v += temp[yy*w+x] * kernel[k+radius]
			}
			result[y*w+x] = v
		}
	}
	return result
}
