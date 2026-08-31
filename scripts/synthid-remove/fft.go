package main

import (
	"math"
)

// nextPow2 returns the smallest power of 2 >= n.
func nextPow2(n int) int {
	if n <= 0 {
		return 1
	}
	p := 1
	for p < n {
		p <<= 1
	}
	return p
}

// fft1d performs an in-place radix-2 Cooley-Tukey FFT on a.
// len(a) must be a power of 2.
func fft1d(a []complex128) {
	n := len(a)
	if n <= 1 {
		return
	}

	// Bit-reversal permutation
	j := 0
	for i := 1; i < n; i++ {
		bit := n >> 1
		for j&bit != 0 {
			j ^= bit
			bit >>= 1
		}
		j ^= bit
		if i < j {
			a[i], a[j] = a[j], a[i]
		}
	}

	// Cooley-Tukey butterfly
	for length := 2; length <= n; length <<= 1 {
		ang := -2.0 * math.Pi / float64(length)
		wlen := complex(math.Cos(ang), math.Sin(ang))
		half := length / 2
		for i := 0; i < n; i += length {
			w := complex(1, 0)
			for k := 0; k < half; k++ {
				u := a[i+k]
				v := a[i+k+half] * w
				a[i+k] = u + v
				a[i+k+half] = u - v
				w *= wlen
			}
		}
	}
}

// ifft1d performs an in-place inverse FFT on a.
// len(a) must be a power of 2.
func ifft1d(a []complex128) {
	n := len(a)

	// Conjugate
	for i := range a {
		a[i] = complex(real(a[i]), -imag(a[i]))
	}

	fft1d(a)

	// Conjugate and scale
	invN := 1.0 / float64(n)
	for i := range a {
		a[i] = complex(real(a[i])*invN, -imag(a[i])*invN)
	}
}

// fft2d performs a 2D FFT on data (row-major, rows×cols).
// Both rows and cols must be powers of 2.
func fft2d(data []complex128, rows, cols int) {
	// FFT each row
	row := make([]complex128, cols)
	for r := 0; r < rows; r++ {
		copy(row, data[r*cols:(r+1)*cols])
		fft1d(row)
		copy(data[r*cols:(r+1)*cols], row)
	}

	// FFT each column
	col := make([]complex128, rows)
	for c := 0; c < cols; c++ {
		for r := 0; r < rows; r++ {
			col[r] = data[r*cols+c]
		}
		fft1d(col)
		for r := 0; r < rows; r++ {
			data[r*cols+c] = col[r]
		}
	}
}

// ifft2d performs a 2D inverse FFT on data (row-major, rows×cols).
func ifft2d(data []complex128, rows, cols int) {
	// IFFT each row
	row := make([]complex128, cols)
	for r := 0; r < rows; r++ {
		copy(row, data[r*cols:(r+1)*cols])
		ifft1d(row)
		copy(data[r*cols:(r+1)*cols], row)
	}

	// IFFT each column
	col := make([]complex128, rows)
	for c := 0; c < cols; c++ {
		for r := 0; r < rows; r++ {
			col[r] = data[r*cols+c]
		}
		ifft1d(col)
		for r := 0; r < rows; r++ {
			data[r*cols+c] = col[r]
		}
	}
}
