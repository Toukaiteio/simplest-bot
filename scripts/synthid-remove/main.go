package main

import (
	"encoding/json"
	"flag"
	"fmt"
	_ "image/jpeg" // register JPEG decoder
	_ "image/png"  // register PNG decoder
	"math"
	"math/rand"
	"os"
	"time"
)

// Preset configures the strength of each pipeline stage.
type Preset struct {
	ElasticAlpha      float64 // Stage 2: displacement magnitude (pixels)
	ElasticSigmaFactor float64 // Stage 2: smoothness (20=smooth, 50=fragmented)
	RotationDeg       float64 // Stage 3: rotation angle (degrees)
	ZoomFactor        float64 // Stage 3: zoom factor
	ShiftPixels       int     // Stage 3: max pixel shift
	SqueezeRatio      float64 // Stage 4: downsample ratio
	ColorShift        float64 // Stage 5: color/contrast shift amount
	FFTStrength       float64 // Stage 6: phase scramble strength (0-1)
	FFTScrambleRadius int     // Stage 6: neighborhood radius
	BroadbandStrength  float64 // Stage 6b: broadband phase scramble strength
	BroadbandMinFreq   float64 // Stage 6b: min frequency fraction of Nyquist
	BroadbandMaxFreq   float64 // Stage 6b: max frequency fraction of Nyquist
	JPEGQualities     []int   // Stage 7a: JPEG quality chain
	NoiseSigma        float64 // Stage 7b: luma noise sigma
	BilateralD        int     // Stage 7c: bilateral filter diameter
	BilateralSigmaC   float64 // Stage 7c: color sigma
	BilateralSigmaS   float64 // Stage 7c: spatial sigma
	UnsharpSigma      float64 // Stage 8: sharpening blur sigma
	UnsharpAmount     float64 // Stage 8: sharpening amount
	BlockSmoothSize    int     // Stage 9: block size for color smoothing
	BlockSmoothThresh  float64 // Stage 9: color similarity threshold
	BlockSmoothBlend   float64 // Stage 9: edge preservation blend (0-1)
	GridSnapThreshold  float64 // Stage 8b: color snap threshold
	PSNRFloor         float64 // PSNR floor for rollback (dB)
}

var presets = map[string]Preset{
	"gentle": {
		ElasticAlpha:      0.8,
		ElasticSigmaFactor: 25.0,
		RotationDeg:       0.2,
		ZoomFactor:        1.002,
		ShiftPixels:       1,
		SqueezeRatio:      0.97,
		ColorShift:        0.008,
		FFTStrength:       0.5,
		FFTScrambleRadius: 2,
		BroadbandStrength:  0.2,
		BroadbandMinFreq:   0.02,
		BroadbandMaxFreq:   0.25,
		JPEGQualities:     []int{97},
		NoiseSigma:        0.8,
		BilateralD:        5,
		BilateralSigmaC:   0.05, // [0,1] range — ~13/255
		BilateralSigmaS:   6.0,
		UnsharpSigma:      1.0,
		UnsharpAmount:     0.4,
		BlockSmoothSize:    8,
		BlockSmoothThresh:  0.04,
		BlockSmoothBlend:   0.8,
		GridSnapThreshold:  0.03,
		PSNRFloor:         30.0,
	},
	"final": {
		ElasticAlpha:      1.2,
		ElasticSigmaFactor: 30.0,
		RotationDeg:       0.3,
		ZoomFactor:        1.003,
		ShiftPixels:       1,
		SqueezeRatio:      0.94,
		ColorShift:        0.012,
		FFTStrength:       0.85,
		FFTScrambleRadius: 4,
		BroadbandStrength:  0.35,
		BroadbandMinFreq:   0.02,
		BroadbandMaxFreq:   0.30,
		JPEGQualities:     []int{96, 94},
		NoiseSigma:        1.0,
		BilateralD:        5,
		BilateralSigmaC:   0.06, // [0,1] range — ~15/255
		BilateralSigmaS:   8.0,
		UnsharpSigma:      1.2,
		UnsharpAmount:     0.6,
		BlockSmoothSize:    8,
		BlockSmoothThresh:  0.05,
		BlockSmoothBlend:   0.7,
		GridSnapThreshold:  0.04,
		PSNRFloor:         26.0,
	},
	"nuke": {
		ElasticAlpha:      1.8,
		ElasticSigmaFactor: 35.0,
		RotationDeg:       0.5,
		ZoomFactor:        1.005,
		ShiftPixels:       1,
		SqueezeRatio:      0.88,
		ColorShift:        0.02,
		FFTStrength:       0.95,
		FFTScrambleRadius: 5,
		BroadbandStrength:  0.45,
		BroadbandMinFreq:   0.02,
		BroadbandMaxFreq:   0.35,
		JPEGQualities:     []int{94, 91, 96},
		NoiseSigma:        1.5,
		BilateralD:        5,
		BilateralSigmaC:   0.07, // [0,1] range — ~18/255
		BilateralSigmaS:   8.0,
		UnsharpSigma:      1.5,
		UnsharpAmount:     0.8,
		BlockSmoothSize:    8,
		BlockSmoothThresh:  0.06,
		BlockSmoothBlend:   0.6,
		GridSnapThreshold:  0.05,
		PSNRFloor:         22.0,
	},
}

// stageDef defines a single pipeline stage with its execution function.
type stageDef struct {
	name string
	fn   func(*FloatImage) *FloatImage
}

// runPipeline executes the SynthID removal pipeline with PSNR-gated rollback.
// Each stage is applied independently; if it would drop PSNR below the floor,
// the stage is rolled back (previous output is kept).
func runPipeline(original *FloatImage, preset Preset) (*FloatImage, []string, float64) {
	stages := []stageDef{
		{"elastic_deform", func(img *FloatImage) *FloatImage {
			return elasticDeform(img, preset.ElasticAlpha, preset.ElasticSigmaFactor)
		}},
		{"geometric_combo", func(img *FloatImage) *FloatImage {
			return geometricCombo(img, preset.RotationDeg, preset.ZoomFactor, preset.ShiftPixels)
		}},
		{"resize_squeeze", func(img *FloatImage) *FloatImage {
			return resizeSqueeze(img, preset.SqueezeRatio)
		}},
		{"color_nudge", func(img *FloatImage) *FloatImage {
			return colorNudge(img, preset.ColorShift)
		}},
		{"fft_scramble", func(img *FloatImage) *FloatImage {
			return fftCarrierScramble(img, preset.FFTStrength, preset.FFTScrambleRadius)
		}},
		{"broadband_fft", func(img *FloatImage) *FloatImage {
			return broadbandFFTScramble(img, preset.BroadbandStrength, preset.BroadbandMinFreq, preset.BroadbandMaxFreq)
		}},
		{"jpeg_chain", func(img *FloatImage) *FloatImage {
			return jpegChain(img, preset.JPEGQualities)
		}},
		{"luma_noise", func(img *FloatImage) *FloatImage {
			return addLumaNoise(img, preset.NoiseSigma)
		}},
		{"bilateral", func(img *FloatImage) *FloatImage {
			return bilateralFilter(img, preset.BilateralD, preset.BilateralSigmaC, preset.BilateralSigmaS)
		}},
		{"unsharp_mask", func(img *FloatImage) *FloatImage {
			return unsharpMask(img, preset.UnsharpSigma, preset.UnsharpAmount)
		}},
		{"grid_snap", func(img *FloatImage) *FloatImage {
			return gridSnap(img, 8, preset.GridSnapThreshold)
		}},
		{"block_smooth", func(img *FloatImage) *FloatImage {
			return blockColorSmooth(img, preset.BlockSmoothSize, preset.BlockSmoothThresh, preset.BlockSmoothBlend)
		}},
	}

	current := original
	var applied []string

	for _, stage := range stages {
		output := stage.fn(current)
		psnr := computePSNR(original, output)

		if math.IsInf(psnr, 1) || psnr >= preset.PSNRFloor {
			current = output
			applied = append(applied, stage.name)
		}
		// else: rollback, keep current
	}

	finalPSNR := computePSNR(original, current)
	return current, applied, finalPSNR
}

func main() {
	input := flag.String("i", "", "input image path (PNG/JPEG)")
	output := flag.String("o", "", "output image path (PNG/JPEG)")
	strength := flag.String("s", "final", "strength preset: gentle|final|nuke")
	seed := flag.Int64("seed", 0, "random seed (0 = time-based)")
	flag.Parse()

	if *input == "" || *output == "" {
		fmt.Fprintln(os.Stderr, "Usage: synthid-remove -i <input> -o <output> [-s gentle|final|nuke] [-seed N]")
		os.Exit(1)
	}

	preset, ok := presets[*strength]
	if !ok {
		fmt.Fprintf(os.Stderr, "Unknown strength: %s (use: gentle, final, nuke)\n", *strength)
		os.Exit(1)
	}

	if *seed != 0 {
		rand.Seed(*seed)
	} else {
		rand.Seed(time.Now().UnixNano())
	}

	// Load image
	img, err := loadImage(*input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading image: %v\n", err)
		os.Exit(1)
	}

	original := toFloatImage(img)

	// Run pipeline
	result, stagesApplied, psnr := runPipeline(original, preset)

	// Save output
	outImg := toRGBA(result)
	err = saveImage(outImg, *output)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error saving image: %v\n", err)
		os.Exit(1)
	}

	// Print JSON result to stdout
	resultJSON := map[string]interface{}{
		"success":      true,
		"psnr":         math.Round(psnr*100) / 100,
		"stages":       stagesApplied,
		"strength":     *strength,
		"input":        *input,
		"output":       *output,
	}
	out, _ := json.Marshal(resultJSON)
	fmt.Println(string(out))
}
